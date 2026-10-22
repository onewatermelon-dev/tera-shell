/**
 * 会话级的 shell 集成状态（OSC 133）。
 *
 * 解析器（osc133.ts）只认标记；这里把标记翻译成「终端现在处于什么阶段」
 * 并回答三个此前只能靠猜的问题：
 *
 * 1. **提示符在哪儿结束** —— `B` 那一刻的光标位置就是输入起点。
 *    `stripPrompt` 靠 `> $ #` 猜，遇到自定义/彩色/多行提示符就失准。
 * 2. **用户实际敲了什么命令** —— 从 `B` 的起点读到光标处，就是命令行，
 *    与提示符长什么样无关；`C` 到达时再读一次还能拿到 Tab 补全展开后的
 *    最终形态。
 * 3. **命令什么时候真的结束** —— `D;exit=N` 是权威结束点，取代
 *    「静默 1.5 秒算结束」的启发式。
 *
 * ## 为什么挂在 xterm 的 OSC handler 上
 *
 * `registerOscHandler(133, …)` 在解析到该序列的**当下**回调：光标正好
 * 停在序列位置，`B` 的列坐标因此天然正确。若改成自己扫输出流、事后
 * 处理，同一块里 `B`+`C` 连着到时光标已经跑到命令行末尾，读出来的
 * 输入起点是行尾 —— 命令文本永远是空的。
 *
 * ## 拿不到标记时
 *
 * `available` 为 false 表示远端没装钩子（或 shell 不支持），调用方
 * 必须原地退回原有的启发式，行为与接入前完全一致。
 */
import { logWarn } from "@/shared/lib/log";
import type {
  IMarker,
  Terminal
} from "@xterm/xterm";
import {
  parseOsc133Event,
  type Osc133Event
} from "./osc133";
import {
  parseOsc7,
  parsePromptCwd
} from "./osc7";

/** 提示符结束时（B）记下的输入起点。 */
export interface PromptPoint {
  /** 绝对行号（缓冲区坐标，含回滚） */
  line: number;
  /** 列（0 基） */
  column: number;
}

/** 应急开关在 localStorage 里的键。 */
const DISABLE_KEY =
  "tera-shell:shell-integration";

/**
 * 是否被应急开关关掉。
 *
 * 集成只影响增强项（历史、通知精度、补全时机），出问题时要能让用户
 * **立刻**回到接入前的行为、并且一眼看出"是不是它引起的"。控制台执行
 * `localStorage.setItem("tera-shell:shell-integration", "off")` 再刷新即可，
 * 相当于全部退回启发式（不注册 handler、不部署钩子）。
 */
export function shellIntegrationDisabled(): boolean {
  try {
    return (
      localStorage.getItem(DISABLE_KEY) === "off"
    );
  } catch {
    // 隐私模式等拿不到 localStorage 时按「未关闭」处理
    return false;
  }
}

/** 宿主关心的事件回调；全部可选。 */
export interface ShellIntegrationHooks {
  /** 新提示符开始（A）：上一条命令的输出已结束 */
  onPromptStart?(): void;
  /**
   * 命令开始执行（C）：`command` 是从输入起点读到的命令行。
   *
   * 这是**最可靠**的命令文本来源 —— 比回车瞬间读缓冲区准（那时回显
   * 可能还没到），也比 `stripPrompt` 准（不依赖提示符样式）。
   */
  onCommandStart?(command: string | null): void;
  /** 命令执行结束（D）：带上远端 shell 给出的退出码 */
  onCommandEnd?(exitCode: number | null): void;
  /**
   * 当前工作目录变了（OSC 7）。
   *
   * 只在路径**真的**变了时回调（每个提示符都会发 OSC 7，不去重会导致
   * 目录栏每次回车都重新拉一遍列表）。
   */
  onCwdChange?(cwd: string): void;
}

/** 会话级的 shell 集成句柄。 */
export interface ShellIntegration {
  /** 远端钩子是否生效（见过至少一个标记）。 */
  readonly available: boolean;
  /** 是否停在提示符处（B 之后、C 之前）—— 只有这时才该弹补全建议。 */
  readonly atPrompt: boolean;
  /** 是否正在执行命令（C..D 之间）。 */
  readonly running: boolean;
  /**
   * 喂一个 OSC 133 序列体（`A` / `D;exit=1`）。
   *
   * 生产路径由 xterm 的 OSC handler 调用；测试直接调它模拟远端输出。
   */
  feed(body: string): void;
  /**
   * 喂一条 OSC 7 载荷（`file://host/path`）。
   *
   * 生产路径由 xterm 的 OSC 7 handler 调用；测试直接调它模拟远端上报目录。
   */
  feedCwd(data: string): void;
  /** 提示符结束位置；未见过 B 时为 null。 */
  promptEnd(): PromptPoint | null;
  /**
   * 提示符之后到光标处的文本（= 用户当前输入）。
   *
   * 未见过 B（没有集成）时返回空串，调用方据此回退。
   */
  readInput(): string;
  /** 最近一条已开始执行的命令文本。 */
  lastCommand(): string | null;
  /** 远端 shell 的当前工作目录（OSC 7）；没收到过为空串。 */
  readonly cwd: string;
  /**
   * 丢弃当前的输入起点（注入过内容、屏幕被我们改写之后调用）。
   *
   * `cat`/`vim`/`/?` 这几条拦截路径会往本会话 pts 注入文本并重画一个
   * **假的**提示符；它不是远端 shell 画的，没有 A/B 标记，此时 B 记下的
   * 起点已经对不上光标了。清掉它，等远端下一次 B 重新定位 —— 中间这段
   * 时间退回启发式，比拿着错的坐标硬算安全。
   */
  reset(): void;
  /** 注销 OSC handler 并释放 marker。 */
  dispose(): void;
}

/**
 * 把缓冲区里 [起点, 光标] 之间的文本读出来。
 *
 * 单行命令就是 `line.slice(column, cursorX)`；多行（heredoc、`for` 循环）
 * 逐行拼接，续行开头的 PS2 提示符（默认 `> `）会被剥掉，否则命令历史里
 * 会出现一堆 `> ` 前缀。
 *
 * @param terminal 目标终端
 * @param point 输入起点
 */
function readRegion(
  terminal: Terminal,
  point: PromptPoint
): string {
  const buffer = terminal.buffer.active;
  const endLine = buffer.baseY + buffer.cursorY;
  const endColumn = buffer.cursorX;
  if (point.line < 0 || endLine < point.line)
    return "";
  let text = "";
  for (
    let line = point.line;
    line <= endLine;
    line++
  ) {
    const row = buffer.getLine(line);
    if (!row) continue;
    const content = row.translateToString(false);
    const from =
      line === point.line ? point.column : 0;
    const to =
      line === endLine
        ? endColumn
        : content.length;
    if (to <= from) continue;
    const piece = content.slice(from, to);
    if (line === point.line) {
      text += piece;
    } else {
      text += `\n${piece.replace(/^(?:>|\+)\s?/, "")}`;
    }
  }
  return text;
}

/** 去掉行尾空白。 */
function cleanCommand(raw: string): string {
  return raw.replace(/[ \t]+$/, "");
}

/**
 * 建一个会话级集成对象（不注册 handler，便于测试直接 feed）。
 *
 * @param terminal 目标终端（读缓冲区用）
 * @param hooks 事件回调
 */
export function createShellIntegration(
  terminal: Terminal,
  hooks: ShellIntegrationHooks = {}
): ShellIntegration {
  let available = false;
  let atPrompt = false;
  let running = false;
  /** B 时刻的输入起点：marker 跟内容走，滚动后仍然指对行 */
  let marker: IMarker | null = null;
  let markerColumn = 0;
  let command: string | null = null;
  /** 最近一次 OSC 7 报上来的目录 */
  let cwd = "";
  /** 是否收到过 OSC 7（收到后就不再采用提示符推断的结果） */
  let cwdFromOsc7 = false;

  /**
   * 喂一条 OSC 7（`file://host/path`）。
   *
   * 与 `feed`（OSC 133）分开：两者语义不同，混在一个 switch 里会让
   * 133 的解析器背上一半无关逻辑。
   *
   * @param data OSC 7 载荷
   */
  const feedCwd = (data: string) => {
    const next = parseOsc7(data);
    if (!next) return;
    // 权威来源到了：之后的提示符推断一律让位
    cwdFromOsc7 = true;
    if (next === cwd) return;
    cwd = next;
    // 目录栏「不跟随」时先看有没有这行：没有 = 钩子没发 OSC 7
    console.info("[cwd] OSC 7 →", next);
    hooks.onCwdChange?.(next);
  };

  const point = (): PromptPoint | null =>
    marker && marker.line >= 0
      ? {
          line: marker.line,
          column: markerColumn
        }
      : null;

  const clearMarker = () => {
    marker?.dispose();
    marker = null;
    markerColumn = 0;
  };

  const handle = (event: Osc133Event) => {
    switch (event.kind) {
      case "prompt-start":
        atPrompt = false;
        running = false;
        hooks.onPromptStart?.();
        break;
      case "prompt-end": {
        // 提示符刚画完：此刻光标就是输入起点
        const buffer = terminal.buffer.active;
        // 兜底跟随：钩子还没发 OSC 7（老版本 / 没重载）时，从提示符
        // 文本里猜目录 —— 绝大多数 PS1 都把 \w 画在里面。
        // 一旦收到过 OSC 7 就只用权威值，避免 `~` 把真实路径盖回去。
        if (!cwdFromOsc7) {
          const line = buffer.getLine(
            buffer.baseY + buffer.cursorY
          );
          const promptText = line
            ? line
                .translateToString(true)
                .slice(0, buffer.cursorX)
            : "";
          const guess =
            parsePromptCwd(promptText);
          if (guess && guess !== cwd) {
            cwd = guess;
            console.info(
              "[cwd] 提示符推断 →",
              guess
            );
            hooks.onCwdChange?.(guess);
          }
        }
        clearMarker();
        marker =
          terminal.registerMarker(0) ?? null;
        markerColumn = buffer.cursorX;
        atPrompt = true;
        break;
      }
      case "command-start": {
        atPrompt = false;
        running = true;
        const start = point();
        const text = start
          ? cleanCommand(
              readRegion(terminal, start)
            )
          : "";
        command = text || null;
        if (command)
          console.debug(
            "[shell-integration] 命令开始",
            command
          );
        hooks.onCommandStart?.(command);
        break;
      }
      case "command-end":
        running = false;
        atPrompt = false;
        console.debug(
          "[shell-integration] 命令结束",
          event.exitCode
        );
        hooks.onCommandEnd?.(event.exitCode);
        break;
    }
  };

  const api: ShellIntegration = {
    get available() {
      return available;
    },
    get atPrompt() {
      return atPrompt;
    },
    get running() {
      return running;
    },
    feed(body) {
      const event = parseOsc133Event(body);
      if (!event) return;
      if (!available) {
        available = true;
        console.info(
          "[shell-integration] 远端钩子已生效"
        );
      }
      handle(event);
    },
    promptEnd: point,
    readInput() {
      const start = point();
      if (!start) return "";
      return cleanCommand(
        readRegion(terminal, start)
      );
    },
    lastCommand() {
      return command;
    },
    get cwd() {
      return cwd;
    },
    feedCwd,
    reset() {
      atPrompt = false;
      running = false;
      clearMarker();
    },
    dispose() {
      clearMarker();
    }
  };
  return api;
}

/**
 * 给一只终端挂上 shell 集成：把 OSC 133 交给 xterm 的解析器处理。
 *
 * ⚠️ handler 必须**消费**掉这个 OSC（返回 true）：xterm 对未注册的 OSC
 * 是静默丢弃，但注册之后返回 false 会让它继续走默认路径（部分版本会
 * 打印警告），白白多一份噪音。
 *
 * @param terminal 目标终端
 * @param hooks 事件回调
 */
export function attachShellIntegration(
  terminal: Terminal,
  hooks: ShellIntegrationHooks = {}
): ShellIntegration {
  const integration = createShellIntegration(
    terminal,
    hooks
  );
  // 应急开关关闭时**一个 handler 都不注册**：输出流与接入前完全一致
  if (shellIntegrationDisabled()) {
    console.info(
      "[shell-integration] 已被应急开关关闭（localStorage tera-shell:shell-integration=off）"
    );
    return integration;
  }
  let registration: { dispose(): void } | null =
    null;
  try {
    registration =
      terminal.parser.registerOscHandler(
        133,
        data => {
          try {
            integration.feed(data);
          } catch (reason) {
            // 钩子是远端发的，脏数据不该让整条输出流卡住
            logWarn(
              "[shell-integration] 标记处理失败",
              reason
            );
          }
          return true;
        }
      );
  } catch (reason) {
    // ⚠️ 注册不上就彻底退回启发式：这里抛出去会连累终端建不出来
    // （症状是点会话一片空白），而集成本来就只是增强项，绝不能
    // 成为终端可用的前提
    logWarn(
      "[shell-integration] OSC handler 注册失败，本次退回启发式",
      reason
    );
    return integration;
  }
  // OSC 7（当前工作目录）：目录栏「实时跟随」的数据源。
  // 单独注册、失败也不影响 133 —— 拿不到目录只是目录栏空着，
  // 不能因此把补全与退出码一起拖下水。
  let cwdRegistration: {
    dispose(): void;
  } | null = null;
  try {
    cwdRegistration =
      terminal.parser.registerOscHandler(
        7,
        data => {
          try {
            integration.feedCwd(data);
          } catch (reason) {
            logWarn(
              "[shell-integration] OSC 7 处理失败",
              reason
            );
          }
          return true;
        }
      );
  } catch (reason) {
    logWarn(
      "[shell-integration] OSC 7 注册失败，目录栏将没有跟随目录",
      reason
    );
  }
  // dispose 要一并注销 handler：终端销毁后残留的注册会持有闭包
  const dispose =
    integration.dispose.bind(integration);
  return Object.assign(integration, {
    dispose() {
      registration?.dispose();
      cwdRegistration?.dispose();
      dispose();
    }
  });
}
