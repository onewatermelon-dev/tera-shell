/**
 * 前端日志：console + 落盘。
 *
 * 为什么要有这一层：前端 `console.*` 只活在 DevTools 里，用户报 issue 时
 * 既带不出来、也早被关窗清掉了 —— 诊断包里过去只有 Rust 侧日志。这里
 * 把前端日志按级别转发给后端（`frontend_log` 命令），进同一份文件。
 *
 * 两条通路都会落盘（见 `installConsoleBridge`）：
 * - `logInfo/logWarn/logError` —— 明确知道级别的业务日志；
 * - **裸 `console.log/info/debug/warn/error`** —— 早期代码和排查现场
 *   大量直接用的就是 console，只转发助手等于漏掉一半现场。
 *
 * 三条硬约束：
 * 1. **绝不因为日志本身失败而影响业务**：调用是 fire-and-forget，
 *    落盘失败只留 console。
 * 2. **限流**：渲染循环里的报错会在几百毫秒内刷出上千条，必须去重 +
 *    限速，否则日志文件自己把磁盘写满。
 * 3. **不吞异常**：这一层只"记录"，不 catch 业务错误、不改控制流。
 */
import { invoke } from "@tauri-apps/api/core";

type Level = "debug" | "info" | "warn" | "error";

/** 同一条消息在这个窗口内只落盘一次（渲染循环去重的关键） */
const DEDUPE_MS = 2000;
/** 每秒最多落盘条数：超出的直接丢，并在下一条里报告丢掉多少 */
const BUDGET_PER_SECOND = 40;

const seen = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;
let dropped = 0;

/**
 * 把任意值转成一行文本。
 *
 * Error 带 message（stack 太长，日志文件里没意义，只在 console 里看）。
 */
function stringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 判断这条消息是否值得落盘（去重 + 限流）。 */
function shouldSend(text: string): boolean {
  const now = Date.now();
  const last = seen.get(text);
  if (
    last !== undefined &&
    now - last < DEDUPE_MS
  ) {
    return false;
  }
  // 去重表别无限长：超过一定规模清掉旧条目
  if (seen.size > 500) {
    for (const [key, at] of seen) {
      if (now - at > DEDUPE_MS) seen.delete(key);
    }
  }
  seen.set(text, now);

  if (now - windowStart >= 1000) {
    windowStart = now;
    windowCount = 0;
    if (dropped > 0) {
      windowCount += 1;
      void send(
        "warn",
        `[log] 上一秒有 ${dropped} 条日志被限流丢弃`
      );
      dropped = 0;
    }
  }
  if (windowCount >= BUDGET_PER_SECOND) {
    dropped += 1;
    return false;
  }
  windowCount += 1;
  return true;
}

/**
 * 真正写日志的地方。
 *
 * `invoke` 在单测 / 非 Tauri 环境不可用，异常要吞掉 —— 日志失败绝不能
 * 冒泡成业务错误。
 */
async function send(
  level: Level,
  message: string
): Promise<void> {
  try {
    await invoke("frontend_log", {
      level,
      message
    });
  } catch {
    // 非 Tauri 环境（vitest）或后端未就绪：console 里已经有了，够了
  }
}

function emit(
  level: Level,
  message: string,
  detail: unknown[]
): void {
  // console 保留：开发者体验照旧，只是多了一份可导出的副本。
  // helperDepth 让桥接层知道「这条是助手转发的」，避免同一个事件落盘两份。
  helperDepth += 1;
  try {
    console[level](message, ...detail);
  } finally {
    helperDepth -= 1;
  }
  forward(level, [message, ...detail]);
}

/** 单条日志落盘的最大字符数：对象被 JSON 化后可能很长，截断即可。 */
const MAX_LINE = 2000;

/** 把一组 console 参数转发到后端（去重 + 限流后）。 */
function forward(
  level: Level,
  args: unknown[]
): void {
  const text = args
    .map(stringify)
    .join(" ")
    .trim()
    .slice(0, MAX_LINE);
  if (!text) return;
  if (shouldSend(text)) void send(level, text);
}

/** 由 `log*` 助手触发的 console 调用深度；桥接层据此跳过重复转发。 */
let helperDepth = 0;

/**
 * 桥接标记挂在 `globalThis` 而不是模块变量上。
 *
 * ⚠️ 模块变量在 **HMR / 模块重载**后会重置，于是 console 被包第二层 ——
 * 之后每条 console 都会被转发两遍（日志里每个错误出现两次，极易误判成
 * 「错误发生了两次」）。挂全局标记后，无论模块重载几次都只装一层。
 */
const BRIDGE_FLAG = "__teraConsoleBridged";

/**
 * 把 `console.*` 整体接到日志文件（`main.tsx` 启动时调一次）。
 *
 * ## 为什么要 patch console 而不是只用 log* 助手
 *
 * 项目里大量排查现场是直接 `console.debug(...)` 写的（心跳、通知判定、
 * 粘贴拦截、窗格同步）。这些恰恰是出事时最想看的东西，却从来进不了
 * 诊断包。补一层桥接，比回头把上千处调用改成 `logDebug` 现实得多。
 *
 * ## 三个必须防的坑
 *
 * - **重复落盘**：助手内部也走 console，桥接层要靠 `helperDepth` 让路；
 * - **递归**：`send` 失败时只在 catch 里静默，绝不回头再打 console；
 * - **刷屏**：沿用同一套去重 + 每秒 40 条的预算，渲染循环打不爆日志。
 */
export function installConsoleBridge(): void {
  const holder = globalThis as {
    [BRIDGE_FLAG]?: boolean;
  };
  if (holder[BRIDGE_FLAG]) return;
  holder[BRIDGE_FLAG] = true;
  // console.log 也要接（大量排查现场用的是它），归到 info 级别
  const methods: {
    method:
      "debug" | "log" | "info" | "warn" | "error";
    level: Level;
  }[] = [
    { method: "debug", level: "debug" },
    { method: "log", level: "info" },
    { method: "info", level: "info" },
    { method: "warn", level: "warn" },
    { method: "error", level: "error" }
  ];
  for (const { method, level } of methods) {
    const original =
      console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      // 助手已经转发过这一条了
      if (helperDepth > 0) return;
      forward(level, args);
    };
  }
  logInfo("[log] 控制台输出已接入日志文件");
}

/** 普通信息（生命周期、关键动作）。 */
export function logInfo(
  message: string,
  ...detail: unknown[]
): void {
  emit("info", message, detail);
}

/** 可恢复的问题（降级、重试、被限流）。 */
export function logWarn(
  message: string,
  ...detail: unknown[]
): void {
  emit("warn", message, detail);
}

/** 明确的失败（调用失败、用户可见的错误）。 */
export function logError(
  message: string,
  ...detail: unknown[]
): void {
  emit("error", message, detail);
}

/**
 * 安装全局错误钩子（`main.tsx` 启动时调一次）。
 *
 * 覆盖两条以前完全不会进日志的路径：
 * - 未捕获的同步异常（某处忘了 try/catch）
 * - Promise 未处理的 rejection（`void invoke(...)` 漏了 catch）
 */
export function installGlobalErrorLogging(): void {
  // 先接 console：确保后面任何一处报错（包括桥接自身）都有机会落盘
  installConsoleBridge();
  window.addEventListener("error", event => {
    logError(
      "[window.error]",
      event.message || "(无消息)",
      `${event.filename ?? ""}:${event.lineno ?? 0}`,
      event.error
    );
  });
  window.addEventListener(
    "unhandledrejection",
    event => {
      logError(
        "[unhandledrejection]",
        event.reason
      );
    }
  );
  logInfo("[app] 前端日志已接入");
}

/**
 * 带日志的 invoke：命令失败时把**命令名**与原因一起落盘。
 *
 * 后端命令的 `map_err` 只负责把错误文本交给前端，未必写日志；从调用方
 * 记录能保证"哪个命令、什么参数形状下失败"一定留在诊断包里。
 */
export async function invokeLogged<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    logError(`[invoke] ${command} 失败`, reason);
    throw reason;
  }
}
