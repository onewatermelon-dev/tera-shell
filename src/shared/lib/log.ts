/**
 * 前端日志：console + 落盘。
 *
 * 为什么要有这一层：前端 `console.*` 只活在 DevTools 里，用户报 issue 时
 * 既带不出来、也早被关窗清掉了 —— 诊断包里过去只有 Rust 侧日志。这里
 * 把前端日志按级别转发给后端（`frontend_log` 命令），进同一份文件。
 *
 * 三条硬约束：
 * 1. **绝不因为日志本身失败而影响业务**：调用是 fire-and-forget，
 *    落盘失败只留 console。
 * 2. **限流**：渲染循环里的报错会在几百毫秒内刷出上千条，必须去重 +
 *    限速，否则日志文件自己把磁盘写满。
 * 3. **不吞异常**：这一层只"记录"，不 catch 业务错误、不改控制流。
 */
import { invoke } from "@tauri-apps/api/core";

type Level = "info" | "warn" | "error";

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
  // console 保留：开发者体验照旧，只是多了一份可导出的副本
  if (level === "error")
    console.error(message, ...detail);
  else if (level === "warn")
    console.warn(message, ...detail);
  else console.info(message, ...detail);

  const text =
    detail.length > 0
      ? `${message} ${detail.map(stringify).join(" ")}`
      : message;
  if (shouldSend(text)) void send(level, text);
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
