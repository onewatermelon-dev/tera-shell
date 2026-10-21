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
import { readRecentOutput } from "@/terminal/lib/failureDiagnosis";
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
  /** 命令历史检索面板（历史快捷键调起，见 HistoryPanel） */
  openHistorySearch: () => void;
  /**
   * 一段文本被粘进这只终端（剪贴板粘贴 / 右键粘贴都走这里）。
   *
   * 由宿主决定「要不要事后纠正」—— 见 lib/pasteGuard。
   * 组件这一层不做判断：要不要拦是产品策略，不是渲染逻辑。
   *
   * @param text 粘贴内容
   * @param before 粘贴**之前**输入行里的文本（Ctrl+V 路径能拿到；
   *               原生粘贴随后会把它弄脏，所以只能在插入前读）
   */
  requestPaste: (
    text: string,
    before?: string
  ) => void;
  /**
   * 命令以非零退出码结束（依赖 OSC 133 的 D 标记）。
   *
   * 只上报现场，**不在这里调 AI** —— 要不要看由用户点角上的提示决定，
   * 否则每条失败命令都会白烧一次 token。
   */
  onCommandFailure?: (failure: {
    command: string;
    exitCode: number;
    output: string;
  }) => void;
  /** 命令成功结束（退出码 0）：用来把上一次的失败提示收掉。 */
  onCommandSuccess?: () => void;
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
    openHistorySearch,
    requestPaste,
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
  /**
   * 本终端最后一次获得焦点的时刻。
   *
   * ⚠️ 不能只靠 `element.contains(event.target)` 认领粘贴：WebView2 里
   * 事件 target 可能报成 document / body，`contains` 为 false，监听就在
   * **取内容之前**直接返回了 —— 连日志都不会打，而文本照样被 xterm
   * 处理进终端。要粘贴必然是用户把焦点放在这只终端上，
   * 用「最近持有过焦点」兜底认领最可靠。
   */
  let lastFocusAt = 0;
  element.addEventListener("focusin", () => {
    lastFocusAt = Date.now();
  });
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
      onCommandEnd: exitCode => {
        // 精确结束点：静默判定让位（见下面的 onWriteParsed）
        commandTimer.finishNow();
        // 退出码回填到刚记下的那条历史（面板里据此标红失败命令）
        completion?.pushExitCode(exitCode);
        // 排查用锚点：D 标记到没到、退出码是多少，一行看清。
        // 稳定后可降为 debug。
        console.info(
          "[diagnose] onCommandEnd exit=",
          exitCode
        );
        // 失败即诊断：非零退出码时把现场打包上报（只上报，不调 AI ——
        // 要不要看由用户点角上的提示决定）
        if (exitCode === null) return;
        if (exitCode === 0) {
          // 接着敲的命令成功了，说明用户已经继续往下走：收掉旧提示，
          // 免得 `grep` 没匹配那种 1 一直挂在角上
          options.onCommandSuccess?.();
          return;
        }
        options.onCommandFailure?.({
          command: lastCommand.current,
          exitCode,
          output: readRecentOutput(terminal)
        });
      }
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
    // 命令历史检索面板。备用屏（vim/less/top 等）里不抢这个组合：
    // 全屏应用自己要用键，抢掉等于把用户的键位吞了
    if (
      event.type === "keydown" &&
      terminal.buffer.active.type !==
        "alternate" &&
      matchTerminalShortcut(
        event,
        "historySearch"
      )
    ) {
      event.preventDefault();
      openHistorySearch();
      return false;
    }
    if (
      event.type !== "keydown" ||
      !event.ctrlKey
    )
      return true;
    const key = event.key.toLowerCase();
    /**
     * Ctrl+V / Ctrl+Shift+V。
     *
     * ⚠️ 这里**刻意不 preventDefault、也不设 readOnly**：这套环境
     * （WebView2）里原生粘贴根本拦不住，而一旦「拦了一半」，安全内容就
     * 会出现两份 —— 原生插进去一份、我们自己再 paste 一份。所以统一成
     * 「原生粘贴照常发生」：
     * - 安全内容什么都不用我们做（只此一份）；
     * - 危险内容由防护层事后纠正（弹窗 + 清行重建）。
     *
     * 这里只做两件事：在**插入之前**读下当前输入行（原生粘贴随后会把它
     * 弄脏，事后读不到干净的「粘贴前内容」），以及读剪贴板正文。
     */
    if (key === "v") {
      const before =
        integration.available &&
        integration.atPrompt
          ? integration.readInput()
          : "";
      navigator.clipboard
        .readText()
        .then(text => {
          if (!text) return;
          console.info(
            "[paste] 键盘粘贴",
            `${text.length} 字符`
          );
          requestPaste(text, before);
        })
        .catch(reason => {
          // 读不到剪贴板（权限被拒 / 空剪贴板）：只能记日志，让用户重试。
          // 此时原生粘贴已被 preventDefault，不会再粘一次
          console.warn(
            "[paste] 读取剪贴板失败",
            reason
          );
        });
      return false;
    }
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
  // 粘贴上报：捕获阶段挂在 window 上，只处理落在本终端里的粘贴。
  //
  // ⚠️ **不 preventDefault、不 stopPropagation**：这套环境（WebView2）里
  // 原生粘贴拦不住，一旦拦截只成功一半，安全内容就会变成两份 ——
  // 原生插进去一份、我们再 paste 一份。所以统一成「原生粘贴照常发生」，
  // 这里只把「有内容粘进来了」报给防护层（危险内容由它事后纠正）。
  // ⚠️ 认领判断不能只看 event.target：它可能报成 document / body，
  // 此时 contains 为 false，会在取内容之前就 return（连日志都没有）。
  const pasteTargets = (
    target: EventTarget | null
  ) => {
    if (
      target instanceof Node &&
      element.contains(target)
    )
      return true;
    const active = document.activeElement;
    if (active && element.contains(active))
      return true;
    // 兜底：粘之前焦点一定在这只终端上（点标签/切窗格都会 focusin）
    return Date.now() - lastFocusAt < 3000;
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!pasteTargets(event.target)) return;
    const text =
      event.clipboardData?.getData(
        "text/plain"
      ) ?? "";
    // 图片 / 文件粘贴不归这层管
    if (!text) return;
    console.info(
      "[paste] 捕获粘贴",
      `${text.length} 字符`
    );
    requestPaste(text);
  };
  window.addEventListener("paste", onPaste, true);
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
    execTarget: options.execTarget,
    // window 监听不会随 DOM 移除失效：关闭会话时由 useTerminalPaneOps 调用
    disposeListeners: () => {
      window.removeEventListener(
        "paste",
        onPaste,
        true
      );
    }
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
