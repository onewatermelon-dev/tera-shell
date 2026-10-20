/**
 * 创建一只终端实例（xterm + addon + 输入管线 + 快捷键 + 右键菜单）。
 *
 * 从 useTerminals.ts 的 createTerminal 拆出，改为普通函数（依赖全部
 * 由参数注入）—— 它不持有 React 状态，只是「按会话定义组装一只
 * 可用的终端」。输入管线见 terminalInput.ts。
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/sessions/lib/session";
import type { SshTarget } from "@/sessions/lib/sshTarget";
import type { AppSettings } from "@/settings/lib/settings";
import {
  DEFAULT_FONT_SIZE,
  resolveFontFamily
} from "@/settings/lib/settings";
import { registerTerminalLinks } from "@/terminal/lib/terminalLinks";
import { renderTextOnlySelection } from "@/terminal/lib/terminalSelection";
import { setWebglEnabled } from "@/terminal/lib/webglRenderer";
import { createTerminalMenu } from "@/terminal/lib/terminalContextMenu";
import { attachFontZoom } from "@/terminal/lib/fontZoom";
import { CommandTimer } from "@/lib/notify";
import type { CompletionController } from "@/terminal/lib/commandCompletion";
import { attachShellIntegration } from "@/terminal/lib/shellIntegration/shellIntegration";
import {
  resolveColorScheme,
  toXtermTheme
} from "@/terminal/lib/pane/colorSchemes";
import {
  matchTerminalShortcut,
  attachTerminalInput
} from "./terminalInput";
import type { OpenSession } from "./terminalTypes";

/** 终端外观与行为设置（useTerminals 的 appearance 入参）。 */
export type TerminalAppearance = Pick<
  AppSettings,
  | "fontFamily"
  | "fontSize"
  | "colorScheme"
  | "commandCompletion"
  | "cursorStyle"
  | "cursorBlink"
  | "cursorWidth"
  | "cursorInactiveStyle"
  | "lineHeight"
  | "webglRender"
  | "scrollback"
  | "sshKeyPath"
  | "useSshConfig"
  | "hostKeyPolicy"
>;

/** createTerminalInstance 的参数：createTerminal 原先闭包捕获的全部依赖。 */
export interface CreateTerminalOptions {
  appearance: TerminalAppearance;
  /** SFTP / AI 命令用的连接目标（跳板链 + 私钥 + 明文密码） */
  execTarget: SshTarget;
  onError: (reason: unknown) => void;
  onFontSizeChange: (fontSize: number) => void;
  /** 会话是否已断开（输入管线用） */
  isDisconnected: () => boolean;
  /** 搜索 addon 的结果变化上报（useTerminalSearch.reportResults） */
  reportSearchResults: (
    sessionId: string,
    index: number,
    count: number
  ) => void;
  /** 右键菜单 / 查找快捷键调起的搜索框 */
  openSearch: () => void;
  /** 右键菜单实例（整个应用只建一次，由调用方缓存；
   *  其中的「重新连接」由调用方在建菜单时直接接线） */
  ensureTerminalMenu: () => ReturnType<
    typeof createTerminalMenu
  >;
  /** 字号提示文案（i18n） */
  formatFontSizeHint: (size: number) => string;
  /**
   * 长命令跑完时回调（系统通知用）。
   *
   * 真正的「能不能发」判定在 lib/notifySend 的 notify 里 —— 那里才知道
   * 窗口焦点与设置开关。这里只报「有命令结束了，耗时这么多」。
   */
  onLongCommand?: (
    command: string,
    elapsedMs: number
  ) => void;
}

/**
 * 按会话定义组装一只终端并返回 OpenSession。
 *
 * 注意：此时 PTY 尚未启动（terminal_start 由 startSession 在尺寸
 * 稳定后调用），terminal.open() 也推迟到挂载阶段的 layout effect。
 */
export function createTerminalInstance(
  session: SavedSession,
  sourceSessionId: string,
  options: CreateTerminalOptions
): OpenSession {
  const {
    appearance,
    onError,
    onFontSizeChange,
    isDisconnected,
    reportSearchResults,
    openSearch,
    ensureTerminalMenu,
    formatFontSizeHint,
    onLongCommand
  } = options;
  // 最近一次提交的命令文本：计时结束时才知道用了多久，那时已经
  // 拿不到 onData 的入参了，用 ref 兜住
  const lastCommand = { current: "" };
  const terminal = new Terminal({
    cursorBlink: appearance.cursorBlink,
    cursorStyle: appearance.cursorStyle,
    // 行距 / 光标宽度 / 失焦光标形态均取自设置（改动由外观 effect 推送）
    cursorWidth: appearance.cursorWidth,
    cursorInactiveStyle:
      appearance.cursorInactiveStyle,
    allowProposedApi: true,
    // 字体与字号取自设置；自定义字体会拼在内置字体栈前面，
    // 没装时顺着回退，不会掉成难看的默认衬线体
    fontFamily: resolveFontFamily(
      appearance.fontFamily
    ),
    fontSize: appearance.fontSize,
    lineHeight: appearance.lineHeight,
    // 回滚行数取自设置（改动由 effect 推送到已有终端）
    scrollback: appearance.scrollback,
    theme: toXtermTheme(
      resolveColorScheme(appearance.colorScheme)
    )
  });
  const element = document.createElement("div");
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  searchAddon.onDidChangeResults(event =>
    reportSearchResults(
      session.id,
      event.resultIndex,
      event.resultCount
    )
  );
  registerTerminalLinks(terminal, onError);
  renderTextOnlySelection(terminal, element);
  // 长命令计时器：命令提交时开始。结束点有两个来源，见下面的
  // onWriteParsed 注册与 shell 集成的 D 标记。
  const commandTimer = new CommandTimer(
    elapsedMs =>
      onLongCommand?.(
        lastCommand.current,
        elapsedMs
      )
  );
  // shell 集成（OSC 133）：远端钩子给出的命令边界比启发式准得多 ——
  // 输入起点（B）、命令文本（C）、精确结束与退出码（D）全都用它。
  // 装不上钩子的会话 available 恒为 false，各处自动退回老路径。
  //
  // ⚠️ 回调里用到 completion，而它要等 attachTerminalInput 返回才有：
  // 标记最早也要等远端第一批输出才到，那时赋值已经完成，用闭包推迟读取。
  let completion: CompletionController | null =
    null;
  const integration = attachShellIntegration(
    terminal,
    {
      onCommandStart: command => {
        if (!command) return;
        // C 标记是命令文本最可靠的来源（含 Tab 补全展开后的最终形态），
        // 长命令通知的正文与补全历史都用它
        lastCommand.current = command;
        completion?.pushHistory(command);
      },
      onCommandEnd: () => commandTimer.finishNow()
    }
  );
  // 静默判定只在**没有** shell 集成时兜底。有集成还照旧 poke 的话，
  // `npm install` 中途一段超过 1.5 秒的无输出间隙就会被判成「命令结束」，
  // 弹出一条还没跑完的通知 —— 比没有通知更糟。集成可用时一律等 D 标记。
  terminal.onWriteParsed(() => {
    if (integration.available) return;
    commandTimer.poke();
  });
  // 输入管线：补全 + /? 解释 + vim 配色 + cat 高亮（见 terminalInput）
  const input = attachTerminalInput(
    terminal,
    session,
    {
      onError,
      execTarget: options.execTarget,
      commandCompletion:
        appearance.commandCompletion,
      isDisconnected,
      integration,
      onCommandSubmitted: command => {
        lastCommand.current = command;
        commandTimer.start();
      }
    }
  );
  completion = input.completion;
  terminal.attachCustomKeyEventHandler(event => {
    // 补全接管（ghost 显示中 →/Ctrl+→）：放在 ctrl 分支前面，
    // Ctrl+→ 才不会被当普通按键放行
    if (
      event.type === "keydown" &&
      input.completion.consumeKeydown(event)
    ) {
      event.preventDefault();
      return false;
    }
    // ⚠️ **查找的键位从生效表读**（不是硬编码 Ctrl+F）：
    // 用户在设置页改过之后，这里必须跟着变，否则菜单上写着新键位、
    // 按新键位却只在 AppHeader 那条路径生效（而那条被 handledElsewhere
    // 跳过了），表现为「改了完全没用」。
    if (
      event.type === "keydown" &&
      matchTerminalShortcut(event, "find")
    ) {
      event.preventDefault();
      openSearch();
      return false;
    }
    if (
      event.type !== "keydown" ||
      !event.ctrlKey
    )
      return true;
    const key = event.key.toLowerCase();
    // Ctrl+V 交给浏览器原生粘贴（return false 让 xterm 别处理）
    if (key === "v") return false;
    if (key === "c" && terminal.hasSelection()) {
      navigator.clipboard
        .writeText(terminal.getSelection())
        .catch(onError);
      return false;
    }
    return true;
  });
  // Ctrl + 滚轮缩放字号：手势解析与提示都在 fontZoom，这里只提供
  // 「当前字号」（读实例，闭包不会读到过期设置）与写回设置的出口
  attachFontZoom({
    host: element,
    getFontSize: () =>
      terminal.options.fontSize ??
      DEFAULT_FONT_SIZE,
    applyFontSize: onFontSizeChange,
    formatHint: formatFontSizeHint
  });
  element.addEventListener(
    "contextmenu",
    event => {
      const menu = ensureTerminalMenu();
      menu.show(event, terminal, session.id);
    }
  );
  element.addEventListener("mouseup", () => {
    if (
      terminal.hasSelection() &&
      !terminal.getSelection().trim()
    )
      terminal.clearSelection();
  });
  return {
    ...session,
    terminal,
    fit,
    search: searchAddon,
    completion: input.completion,
    integration,
    element,
    mounted: false,
    sourceSessionId,
    execTarget: options.execTarget
  };
}

/** 设置里的硬件加速开关变化时，释放/重建全部终端上的 WebGL addon。 */
export function applyWebglPreference(
  enabled: boolean,
  terminals: Terminal[]
): void {
  // ⚠️ WeakMap 不可遍历，得由调用方把当前所有会话的 terminal 传进来
  if (!enabled) setWebglEnabled(false, terminals);
  else setWebglEnabled(true);
}
