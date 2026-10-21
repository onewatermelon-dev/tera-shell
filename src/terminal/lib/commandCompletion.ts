/**
 * 终端命令补全（PSReadLine 内联预测风格）。
 *
 * 输入行末尾挂一段灰色 ghost text，**→ 整句接受、Ctrl+→ 按词接受**，
 * 与 PowerShell 7 的 PSReadLine Inline 预测一致；↑↓ 仍交给 shell 自己的
 * 历史翻页，不做拦截。
 *
 * 建议来源两级：① **当前主机**的命令历史整行前缀匹配（和 PSReadLine
 * 的 history 预测源一样，但按主机隔离 —— 生产机上不会补出测试机的命令）；
 * ② 没敲空格时用内置常用命令字典补首个词。
 *
 * 「现在是否在提示符处」与「提示符在哪儿结束」两个问题，有 shell 集成
 * （OSC 133）时由远端钩子的 B/C 标记直接回答；装不上钩子的会话退回
 * 两个启发式：
 * - 输出里出现备用屏切换序列（vim/top 等全屏应用）期间不出建议；
 * - 只有光标停在输入内容末尾、且 stripPrompt 能剥出命令时才弹。
 */

import type {
  IDecoration,
  IMarker,
  Terminal
} from "@xterm/xterm";
import {
  commandsOfHost,
  historySnapshot,
  historyVersion,
  recordCommand,
  recordExitCode
} from "@/terminal/lib/commandHistory";
import { stripPrompt } from "@/terminal/lib/stripPrompt";
import type { ShellIntegration } from "@/terminal/lib/shellIntegration/shellIntegration";

/**
 * 内置常用命令字典：历史里没有匹配时，对没有空格的输入（还在敲
 * 第一个词）按前缀补全。覆盖 bash 常用命令与 PowerShell 常用 cmdlet，
 * 刻意只收"裸命令"，参数级的补全交给历史。
 */
export const BUILTIN_COMMANDS = [
  "ls",
  "cd",
  "pwd",
  "cat",
  "git",
  "docker",
  "grep",
  "find",
  "mkdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "chmod",
  "chown",
  "tar",
  "unzip",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "systemctl",
  "journalctl",
  "service",
  "top",
  "htop",
  "ps",
  "kill",
  "df",
  "du",
  "free",
  "uname",
  "whoami",
  "history",
  "clear",
  "echo",
  "export",
  "alias",
  "which",
  "man",
  "less",
  "head",
  "tail",
  "nano",
  "vim",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "brew",
  "kubectl",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "python",
  "python3",
  "pip",
  "cargo",
  "make",
  "cmake",
  "gcc",
  "Get-ChildItem",
  "Get-Content",
  "Get-Process",
  "Get-Service",
  "Set-Location",
  "Test-Connection"
];

/**
 * 按主机缓存的命令列表。
 *
 * 补全每次输出解析都要取一次「当前主机的命令」，5000 条全量过滤撑不住
 * 那个频率（打字时每秒几十次）。用 `historyVersion()` 判断缓存是否过期：
 * 历史只在记录命令/回填退出码时变，比较一个整数比重新过滤便宜得多。
 */
let hostCache: {
  host: string;
  version: number;
  commands: string[];
} | null = null;

/**
 * 取某主机的命令列表（时间正序，带缓存）。
 *
 * @param host 当前会话的主机标识（见 commandHistory.hostKeyOf）
 */
function hostCommands(host: string): string[] {
  const version = historyVersion();
  if (
    hostCache &&
    hostCache.host === host &&
    hostCache.version === version
  )
    return hostCache.commands;
  const commands = commandsOfHost(
    historySnapshot(),
    host
  );
  hostCache = { host, version, commands };
  return commands;
}

/**
 * 找当前输入的建议。
 *
 * 规则：先从历史里倒序找第一条「以 input 为前缀且比 input 长」的记录
 * （最近用的优先，和输入完全相同的不算建议）；历史没有且输入还没
 * 出现空格时，用内置字典补第一个词。
 *
 * @param input 当前输入行剥掉提示符后的命令（可含参数）
 * @param history 命令历史，按时间正序存放
 * @returns 完整建议命令；没有则 null
 */
export function findSuggestion(
  input: string,
  history: string[]
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (
      entry &&
      entry.length > trimmed.length &&
      entry.startsWith(trimmed)
    ) {
      return entry;
    }
  }
  if (!/\s/.test(trimmed)) {
    for (const cmd of BUILTIN_COMMANDS) {
      if (
        cmd.length > trimmed.length &&
        cmd.startsWith(trimmed)
      ) {
        return cmd;
      }
    }
  }
  return null;
}

/** 按词接受的步进：一个词 + 它后面的空白（PSReadLine AcceptNextSuggestionWord）。 */
const NEXT_WORD_RE = /^\s*\S+\s*/;

/**
 * 从建议余量里截出「下一个词」（含词后空白）；只剩空白时全部收下。
 *
 * @param remainder 建议里还没被接受的部分
 */
export function acceptNextWord(
  remainder: string
): string {
  const match = NEXT_WORD_RE.exec(remainder);
  return match ? match[0] : remainder;
}

/** 备用屏进入序列（vim/top/htop 等全屏应用会切走主屏）。 */
const ALT_SCREEN_ENTER =
  // eslint-disable-next-line no-control-regex -- 匹配的就是 ESC 控制序列本身
  /\x1b\[\?(?:1049|1047|47)h/;
/** 备用屏退出序列。 */
const ALT_SCREEN_EXIT =
  // eslint-disable-next-line no-control-regex -- 匹配的就是 ESC 控制序列本身
  /\x1b\[\?(?:1049|1047|47)l/;

/** 补全控制器的宿主钩子：写入 PTY 与输入封锁状态由会话侧提供。 */
export interface CompletionHooks {
  /** 把接受的文本当作用户键入写进 PTY（走普通输入通道，靠回显上屏）。 */
  writeToPty(data: string): void;
  /** 会话断连/解释/查看等输入封锁期间不出建议也不接受。 */
  isInputBlocked(): boolean;
  /** 挂载时的开关初值（设置里的命令补全开关），缺省开。 */
  enabled?: boolean;
  /**
   * shell 集成（OSC 133）。可用时「是否在提示符处」与输入起点都由
   * 远端钩子给出，不再需要 stripPrompt 猜提示符。
   */
  integration?: ShellIntegration;
  /**
   * 当前会话的主机标识（见 commandHistory.hostKeyOf）。
   *
   * 历史按它隔离：补全只建议**本机**跑过的命令。必填 —— 忘了传就会
   * 按空主机取，那正好是「历史遗留」那批条目的归属，等于把隔离放开了。
   */
  host: string;
}

/** 补全控制器：由会话在输出与键盘事件里驱动。 */
export interface CompletionController {
  /** 输出块进入终端前调用：识别备用屏切换，及时收起建议。 */
  observeOutput(data: string): void;
  /**
   * 键盘事件拦截：ghost text 显示中按 → / Ctrl+→ 时消费事件并写回
   * 接受的文本；返回 true 表示事件已消费（xterm 不再处理）。
   */
  consumeKeydown(event: KeyboardEvent): boolean;
  /** 回车后记录命令历史（按本机隔离、落盘）。 */
  pushHistory(command: string): void;
  /** 命令结束时回填退出码（有 shell 集成才有，见 OSC 133 的 D 标记）。 */
  pushExitCode(code: number | null): void;
  /** 设置开关（设置页实时切换）：关闭时立即收起 ghost text。 */
  setEnabled(on: boolean): void;
}

/**
 * 给终端挂上命令补全：内部监听 onWriteParsed，在每批回显解析完成后
 * 重算 ghost text，因此打字、退格、Ctrl+U、↑ 翻历史等一切改写输入行
 * 的操作都会自然刷新建议。随 terminal.dispose 一并释放。
 *
 * @param terminal 目标终端实例
 * @param hooks 会话侧钩子（写入通道与输入封锁判断）
 */
export function attachCommandCompletion(
  terminal: Terminal,
  hooks: CompletionHooks
): CompletionController {
  /** 当前完整建议；null 表示不显示。 */
  let suggestion: string | null = null;
  /** 已手动收起建议时对应的输入；输入变了才重新弹。 */
  let dismissedFor: string | null = null;
  /** 正在显示的 ghost（text + 起始列），用于避免同一建议反复重画。 */
  let shown: { text: string; x: number } | null =
    null;
  /** 是否处于备用屏（全屏应用运行中）。 */
  let inAltScreen = false;
  /** 设置页的命令补全开关；关闭时既不弹也不接受。 */
  let enabled = hooks.enabled ?? true;
  let marker: IMarker | null = null;
  let decoration: IDecoration | null = null;

  const hideGhost = () => {
    decoration?.dispose();
    marker?.dispose();
    decoration = null;
    marker = null;
    shown = null;
  };

  /**
   * 在光标处挂 ghost text 装饰。装饰锚在光标单元格上，跟随滚动与
   * 内容重绘，自身不进缓冲区 —— 远端对它一无所知。
   */
  const showGhost = (
    ghost: string,
    x: number
  ) => {
    if (
      shown &&
      shown.text === ghost &&
      shown.x === x
    )
      return;
    hideGhost();
    // 剩余列数截断（给光标留一格），避免长建议溢出到屏幕外
    const maxCells = terminal.cols - x - 1;
    let text = "";
    let cells = 0;
    for (const ch of ghost) {
      const width =
        ch.charCodeAt(0) > 0xff ? 2 : 1;
      if (cells + width > maxCells) break;
      text += ch;
      cells += width;
    }
    if (!text) return;
    marker = terminal.registerMarker(0);
    if (!marker) return;
    decoration =
      terminal.registerDecoration({
        marker,
        x,
        width: cells
      }) ?? null;
    if (!decoration) {
      marker.dispose();
      marker = null;
      return;
    }
    shown = { text, x };
    decoration.onRender(element => {
      element.textContent = text;
      element.classList.add("command-ghost");
    });
  };

  /**
   * 取当前输入行（剥掉提示符之后的命令文本）。
   *
   * 有 shell 集成时用 B 标记定位输入起点 —— 提示符长什么样、几行、
   * 带不带颜色都不影响；且 `atPrompt` 为假（命令正在跑、全屏应用里）
   * 直接返回空串，比猜可靠。没有集成时退回 stripPrompt 的老路子。
   */
  const currentInput = (): string => {
    const integration = hooks.integration;
    if (integration?.available) {
      return integration.atPrompt
        ? integration.readInput()
        : "";
    }
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(
      buffer.baseY + buffer.cursorY
    );
    return stripPrompt(
      (
        line?.translateToString(false) ?? ""
      ).trimEnd()
    );
  };

  /**
   * 重算建议：从缓冲区读光标行 → 剥提示符得当前输入 → 匹配建议。
   * 任何一步不成立（行中改字、空输入、备用屏、输入封锁）都收起。
   */
  const refresh = () => {
    if (
      !enabled ||
      hooks.isInputBlocked() ||
      inAltScreen
    ) {
      suggestion = null;
      hideGhost();
      return;
    }
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(
      buffer.baseY + buffer.cursorY
    );
    // trimEnd 去掉行尾填充；光标列 ≥ 内容长度说明光标停在输入末尾
    // ponytail: cursorX 按列计、字符串按码点计，全角提示符会让两者
    // 错位 —— 只影响中文 PS1 的行中编辑场景，先接受
    const visible = (
      line?.translateToString(false) ?? ""
    ).trimEnd();
    if (buffer.cursorX < visible.length) {
      suggestion = null;
      hideGhost();
      return;
    }
    const input = currentInput();
    if (!input || dismissedFor === input) {
      suggestion = null;
      hideGhost();
      return;
    }
    const found = findSuggestion(
      input,
      hostCommands(hooks.host)
    );
    if (!found) {
      suggestion = null;
      hideGhost();
      return;
    }
    suggestion = found;
    showGhost(
      found.slice(input.length),
      buffer.cursorX
    );
  };

  /** 接受指定余量：立即收起 ghost，把文本当键入写进 PTY（回显上屏）。 */
  const accept = (chunk: string) => {
    suggestion = null;
    dismissedFor = null;
    hideGhost();
    hooks.writeToPty(chunk);
  };

  const consumeKeydown = (
    event: KeyboardEvent
  ): boolean => {
    // 只在光标仍停在行尾时接管方向键；否则放行（← 移动光标后
    // ghost 会在下次回显刷新时自然收起）
    if (
      !enabled ||
      !suggestion ||
      hooks.isInputBlocked()
    )
      return false;
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(
      buffer.baseY + buffer.cursorY
    );
    const visible = (
      line?.translateToString(false) ?? ""
    ).trimEnd();
    if (buffer.cursorX < visible.length)
      return false;
    const input = currentInput();
    // 键入与建议之间有回显延迟，输入若已对不上就放弃接管
    if (!input || !suggestion.startsWith(input)) {
      suggestion = null;
      hideGhost();
      return false;
    }
    const remainder = suggestion.slice(
      input.length
    );
    if (
      event.key === "ArrowRight" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      accept(remainder);
      return true;
    }
    if (
      event.ctrlKey &&
      event.key === "ArrowRight" &&
      !event.altKey &&
      !event.metaKey
    ) {
      accept(acceptNextWord(remainder));
      return true;
    }
    return false;
  };

  const pushHistory = (command: string) => {
    // 空命令、纯空白在这里被 recordCommand 挡掉
    recordCommand(command, hooks.host);
  };

  const pushExitCode = (code: number | null) => {
    if (code === null) return;
    recordExitCode(hooks.host, code);
  };

  // 回显驱动：每批写进终端的内容解析完就重算一次建议
  terminal.onWriteParsed(() => refresh());

  return {
    setEnabled(on) {
      enabled = on;
      if (!on) {
        suggestion = null;
        hideGhost();
      }
    },
    observeOutput(data) {
      if (ALT_SCREEN_ENTER.test(data)) {
        inAltScreen = true;
        suggestion = null;
        hideGhost();
      } else if (ALT_SCREEN_EXIT.test(data)) {
        inAltScreen = false;
      }
    },
    consumeKeydown,
    pushHistory,
    pushExitCode
  };
}
