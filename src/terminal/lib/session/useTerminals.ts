/**
 * 终端总编排：会话生命周期（开/关/复制/拆分/重连）+ 窗格网格 + PTY
 * 尺寸同步。
 *
 * 2026-10-12 起拆分：重逻辑已拆到 session/ 下的子模块，本文件只留编排：
 * - paneGrid.ts    窗格网格状态与标签操作（panes/tree）
 * - ptyResize.ts   PTY 尺寸同步的防抖/暂停/恢复
 * - terminalInput.ts 输入管线（补全 + /? 解释 + vim 配色 + cat 高亮）
 * - terminalCreate.ts 终端实例组装
 * - useTerminalPathDrop.ts SFTP 拖路径进终端的 effect
 * - useTerminalAppearance.ts 字体/字号/配色/硬件加速与回滚行数下发
 * - useTerminalGlobalListeners.ts 输出/退出事件、快捷键、ResizeObserver
 *   与卸载清理
 * - useTerminalSessions.ts 会话生命周期（开/复制/密码补验）
 * - useTerminalPaneOps.ts 会话关闭/批量关闭、拆分窗格、焦点交回
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import { useT } from "@/settings/lib/i18n";
import { enableWebgl } from "@/terminal/lib/webglRenderer";
import { createTerminalMenu } from "@/terminal/lib/terminalContextMenu";
import { useTerminalSearch } from "@/terminal/lib/search/useTerminalSearch";
import { hostKeyOf } from "@/terminal/lib/commandHistory";
import {
  assessPaste,
  type PasteAssessment
} from "@/terminal/lib/pasteGuard";
import { askAiFromTerminal } from "@/terminal/lib/ai/askFromTerminal";
import {
  buildDiagnosisText,
  type TerminalFailure
} from "@/terminal/lib/failureDiagnosis";
import { useTerminalReconnect } from "./useTerminalReconnect";
import type { OpenSession } from "./terminalTypes";
import type { SshTarget } from "@/sessions/lib/sshTarget";
import {
  usePaneGrid,
  type PaneState
} from "./paneGrid";
import { usePtyResizeSync } from "./ptyResize";
import {
  createTerminalInstance,
  type TerminalAppearance
} from "./terminalCreate";
import { useTerminalPathDrop } from "./useTerminalPathDrop";
import { useTerminalAppearance } from "./useTerminalAppearance";
import { useTerminalGlobalListeners } from "./useTerminalGlobalListeners";
import { useTerminalSessions } from "./useTerminalSessions";
import { useTerminalPaneOps } from "./useTerminalPaneOps";

// 会话类型定义在 terminalTypes，这里重新导出，外部仍从 useTerminals 引入
export type { OpenSession };
export type { PaneState };

export function useTerminals(
  onError: (reason: unknown) => void,
  onSavePassword:
    | ((
        sourceSessionId: string,
        encrypted: string
      ) => void)
    | undefined,
  /**
   * 终端外观与行为设置：字体、字号与配色随之变化，整批终端一起更新；
   * 命令补全开关同样实时同步（新建会话取初值，已有会话由 effect 推送）；
   * 回滚行数也在这里，改动会立刻调整已打开终端的滚动缓冲区。
   */
  appearance: TerminalAppearance,
  /**
   * Ctrl + 滚轮缩放字号后的落地：把新字号写回设置。
   *
   * 写回设置是「带记忆」的关键 —— 字号存在设置文件里，重启后照旧；
   * 同时外观 effect 会把新字号推给所有已打开的终端。
   */
  onFontSizeChange: (fontSize: number) => void,
  /**
   * 全部已保存会话：解析跳板机引用链（jumpHostId → `-J` 规格）用。
   * 启动/重连时现场解析而不是存规格字符串 —— 跳板的地址/端口改了，
   * 下次连接自动跟上。
   */
  sessions: SavedSession[],
  /** 长命令跑完时上报（系统通知用）；见 useNotifications */
  onLongCommand?: (
    command: string,
    elapsedMs: number
  ) => void
) {
  const t = useT();
  const [opened, setOpened] = useState<
    OpenSession[]
  >([]);
  const [disconnected, setDisconnected] =
    useState<Record<string, boolean>>({});
  const openedRef = useRef(opened);
  /**
   * 当前会话 id：= **活动窗格正在显示的那只**。
   *
   * 搜索、快捷宏、AI 面板、状态栏都以它为"用户正对着的那只会话"，
   * 因此它必须跟着活动窗格走 —— 焦点在右格时，搜索要搜的是右格那只。
   * 用 ref 暴露给 useTerminalSearch / 输出监听等命令式代码。
   */
  const activeIdRef = useRef("");
  const disconnectedRef = useRef(disconnected);
  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);
  useEffect(() => {
    disconnectedRef.current = disconnected;
  }, [disconnected]);

  // 断线自动重连：SSH 会话被 ssh 以 255 结束（网络断开、远端重启）时
  // 退避重试若干次，失败后由右键菜单手动接管（见 useTerminalReconnect）
  const {
    handleDisconnect,
    reconnect: reconnectSession,
    cancelReconnect,
    cancelAllReconnects
  } = useTerminalReconnect({
    openedRef,
    disconnectedRef,
    setDisconnected,
    cursorBlink: appearance.cursorBlink,
    sshKeyPath: appearance.sshKeyPath,
    useSshConfig: appearance.useSshConfig,
    hostKeyPolicy: appearance.hostKeyPolicy,
    sessions,
    onError
  });

  // 查找能力（搜索框开关、高亮与结果计数），内部自带状态
  const search = useTerminalSearch(
    openedRef,
    activeIdRef
  );

  // ---- 粘贴防护（多行 / 危险命令先确认）----
  const [pasteRequest, setPasteRequest] =
    useState<{
      sessionId: string;
      text: string;
      /**
       * 粘贴**之前**输入行里已有的内容。
       *
       * 确认/取消时先 Ctrl+U 清行、再用它把这一截写回去 —— 因为原生
       * 粘贴可能已经抢先把内容插进输入行了（WebView2 实测拦不住），
       * 只能「先清干净再按用户的决定重建」。
       */
      before: string;
      /**
       * 清行要发几次 `Ctrl+U`。
       *
       * ⚠️ readline 的 `unix-line-discard` **只删当前一行**：多行粘贴
       * （或者粘贴前进里本来就是多行）时发一次只删掉最后一行，剩下的
       * 会留在缓冲区里 —— 表现就是「确认粘贴后多出来几个提示符」。
       * 所以按「粘贴内容行数 + 原有内容行数」重复发。
       */
      clearCount: number;
      assessment: PasteAssessment;
    } | null>(null);
  /**
   * 勾了「本会话不再提示」的会话。
   *
   * 只记内存、按会话 id：重连不清（同一台机器，用户说过他熟），
   * 重启应用清空 —— 关一次就永久生效太危险。
   */
  const pasteGuardBypass = useRef(
    new Set<string>()
  );
  /** 弹窗期间「延迟清行」的定时器（确认/取消时要先取消它）。 */
  const pasteClearTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  /**
   * 文本占几行（空串算 0）。
   *
   * @param text 待统计文本
   */
  function lineCount(text: string): number {
    return text ? text.split(/\r?\n/).length : 0;
  }

  /**
   * 清掉「可能跨多行的当前输入」。
   *
   * ⚠️ readline 的 Ctrl+U（unix-line-discard）**只删光标所在那一行**，
   * 多行输入时发一次只删最后一行，前面几行会留在缓冲区 ——
   * 表现就是「确认粘贴后多出来几个提示符」。所以按行数重复发。
   * 上限 64 次：够覆盖任何正常粘贴，又不至于给一次超长粘贴刷出几千个字节。
   *
   * @param count 需要清掉的行数
   */
  function clearInput(count: number): string {
    return "\x15".repeat(
      Math.min(Math.max(count, 1), 64)
    );
  }

  /**
   * 一段文本要粘进某只终端。
   *
   * ⚠️ **安全内容什么都不做**：这套环境（WebView2）的原生粘贴一定会把
   * 内容插进输入行，我们再 `terminal.paste()` 一次就是两份 ——
   * 「粘一次 `ls -la /tmp` 出现两个」就是这么来的。
   *
   * 只有危险内容才需要事后纠正：记下粘贴前的输入行、清一次行、弹确认框，
   * 由用户决定重建哪一份（确认 = before + 粘贴内容，取消 = before）。
   *
   * @param sessionId 目标会话
   * @param text 粘贴内容
   * @param options.before 粘贴前输入行（Ctrl+V 路径在插入之前读到的）
   * @param options.inserted 内容是否**已经**由原生粘贴插进输入行
   *   （缺省 true）。右键菜单那种「我们自己发起」的粘贴传 false ——
   *   这时安全内容必须由我们 paste，否则什么都不发生。
   */
  const requestPaste = useCallback(
    (
      sessionId: string,
      text: string,
      options?: {
        before?: string;
        inserted?: boolean;
      }
    ) => {
      const session = openedRef.current.find(
        item => item.id === sessionId
      );
      if (
        !session ||
        disconnectedRef.current[sessionId]
      )
        return;
      const assessment = assessPaste(text);
      const inserted =
        options?.inserted !== false;
      // 安全内容：原生插入过的就不再插一次；我们自己发起的才补 paste
      if (
        !assessment.risky ||
        pasteGuardBypass.current.has(sessionId)
      ) {
        if (!inserted)
          session.terminal.paste(text);
        return;
      }
      console.info(
        `[paste] 疑似危险粘贴，等待确认（${assessment.risks
          .map(risk => risk.id)
          .join(", ")}）`
      );
      // 粘贴前的输入行：Ctrl+V 路径在插入前就读好了（传进来）；
      // 右键菜单这类「我们发起」的粘贴此刻行还是干净的，现场读即可
      const integration = session.integration;
      const before =
        options?.before ??
        (inserted
          ? ""
          : integration.available &&
              integration.atPrompt
            ? integration.readInput()
            : "");
      // 清行要覆盖「原有内容 + 粘贴内容」的全部行数（见 clearInput）
      const clearCount =
        lineCount(before) + lineCount(text);
      // 原生粘贴已经把内容插进输入行了：稍等一下（等它落定）再清行，
      // 让弹窗期间看到的是「还没粘」。
      // ⚠️ 定时器要能取消：确认/取消时会重建输入行，这个定时器若在
      // 之后才执行，会把刚写回去的内容又清掉。
      if (pasteClearTimer.current)
        clearTimeout(pasteClearTimer.current);
      pasteClearTimer.current = setTimeout(() => {
        pasteClearTimer.current = null;
        invoke("terminal_write", {
          id: session.id,
          data: clearInput(clearCount),
          command: null
        }).catch(onError);
      }, 120);
      // Ctrl+V 会同时走「键盘路径」与「paste 事件」两条：同一次粘贴
      // 别把弹窗重挂一遍（会闪），内容相同就保持当前请求
      setPasteRequest(current =>
        current &&
        current.sessionId === sessionId &&
        current.text === text
          ? current
          : {
              sessionId,
              text,
              before,
              clearCount,
              assessment
            }
      );
    },
    [onError]
  );

  /**
   * 确认粘贴：先清行，再把「原有输入 + 粘贴内容」写回去。
   *
   * 为什么不是简单 `terminal.paste(text)`：原生粘贴拦不住时，内容**已经**
   * 在输入行里了，再 paste 一次就是两份。统一先 `Ctrl+U` 清掉当前行，
   * 再用我们记下的 `before` 重建 —— 两条路径（拦住了 / 没拦住）结果一致。
   */
  const confirmPaste = useCallback(
    (skipNextTime: boolean) => {
      const request = pasteRequest;
      setPasteRequest(null);
      // 先取消「延迟清行」：它若在重建之后执行，会把刚写回的内容清掉
      if (pasteClearTimer.current) {
        clearTimeout(pasteClearTimer.current);
        pasteClearTimer.current = null;
      }
      if (!request) return;
      if (skipNextTime)
        pasteGuardBypass.current.add(
          request.sessionId
        );
      const session = openedRef.current.find(
        item => item.id === request.sessionId
      );
      if (!session) return;
      const payload = `${request.before}${request.text}`;
      // 先清行再写：两条 invoke 由 IPC 保序，`then` 里再 paste 更稳。
      // 清行按行数重复（多行输入时一次 Ctrl+U 只删一行）
      invoke("terminal_write", {
        id: session.id,
        data: clearInput(request.clearCount),
        command: null
      })
        .then(() => {
          if (payload)
            session.terminal.paste(payload);
        })
        .catch(onError);
      requestAnimationFrame(() =>
        session.terminal.focus()
      );
    },
    [pasteRequest, onError]
  );

  /**
   * 取消粘贴：清行后把粘贴前的输入写回去（没有就留空行）。
   *
   * 剪贴板内容不动 —— 用户随时可以再粘一次。
   */
  const cancelPaste = useCallback(() => {
    const request = pasteRequest;
    setPasteRequest(null);
    // 同上：取消掉待执行的「延迟清行」，避免它在恢复之后又清一次
    if (pasteClearTimer.current) {
      clearTimeout(pasteClearTimer.current);
      pasteClearTimer.current = null;
    }
    if (!request) return;
    const session = openedRef.current.find(
      item => item.id === request.sessionId
    );
    if (!session) return;
    invoke("terminal_write", {
      id: session.id,
      data: clearInput(request.clearCount),
      command: null
    })
      .then(() => {
        if (request.before)
          session.terminal.paste(request.before);
      })
      .catch(onError);
    requestAnimationFrame(() =>
      session.terminal.focus()
    );
  }, [pasteRequest, onError]);

  // ---- 失败即诊断（角上提示，点了才调 AI）----
  /** 每个会话最近一次失败（成功命令会把它收掉，见 onCommandSuccess）。 */
  const [failures, setFailures] = useState<
    Record<string, TerminalFailure>
  >({});

  /** 收掉某会话的失败提示（点关闭 / 点了诊断 / 下一条命令成功）。 */
  const clearFailure = useCallback(
    (sessionId: string) => {
      setFailures(prev => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    },
    []
  );

  /**
   * 命令以非零码结束：只记现场，不调 AI。
   *
   * 事件驱动、不常驻：这里唯一的开销是读一次输出尾部（40 行），
   * token 要等用户点提示才花。
   */
  const handleCommandFailure = useCallback(
    (
      sessionId: string,
      payload: {
        command: string;
        exitCode: number;
        output: string;
      }
    ) => {
      console.info(
        `[diagnose] 命令失败 exit=${payload.exitCode}：${payload.command || "(未识别命令)"}`
      );
      setFailures(prev => ({
        ...prev,
        [sessionId]: {
          sessionId,
          at: Date.now(),
          ...payload
        }
      }));
    },
    []
  );

  /**
   * 点提示 → 把「命令 + 退出码 + 输出尾部」作为一轮提问送进 AI 面板。
   *
   * 走的是与右键「让 AI 看看」同一条通道，面板收起时会自动展开。
   */
  const diagnoseFailure = useCallback(
    (sessionId: string) => {
      const failure = failures[sessionId];
      clearFailure(sessionId);
      if (!failure) return;
      const sent = askAiFromTerminal(
        "diagnose",
        buildDiagnosisText(failure)
      );
      // 没有 AI 面板（本地会话）时通道返回 false：提示照样收掉，
      // 不至于卡在角上
      if (!sent)
        console.warn(
          "[diagnose] 没送到 AI 面板（本地会话不挂面板）"
        );
    },
    [failures, clearFailure]
  );

  // ---- 命令历史检索面板（跨主机可搜，见 HistoryPanel）----
  const [historyOpen, setHistoryOpen] =
    useState(false);
  const openHistorySearch = useCallback(
    () => setHistoryOpen(true),
    []
  );
  const closeHistorySearch = useCallback(() => {
    setHistoryOpen(false);
    // Esc / 点遮罩关闭后把焦点交回终端：否则接下来敲的字全落在
    // 已经关掉的输入框上，用户会以为终端卡了
    const session = openedRef.current.find(
      item => item.id === activeIdRef.current
    );
    requestAnimationFrame(() =>
      session?.terminal.focus()
    );
  }, []);
  /**
   * 把面板里选中的命令插进当前会话的输入行（**不执行**）。
   *
   * 走 normal 的 PTY 写入当作用户键入：远端 readline 回显、光标停在行尾，
   * 用户可以接着改再回车 —— 与 shell 自己 Ctrl+R 之后的行为一致。
   * 断线会话先滤掉：往后端写只会收到「终端会话不存在」，静默失败。
   */
  const insertHistory = useCallback(
    (command: string) => {
      setHistoryOpen(false);
      const session = openedRef.current.find(
        item => item.id === activeIdRef.current
      );
      if (
        !session ||
        disconnectedRef.current[session.id]
      )
        return;
      invoke("terminal_write", {
        id: session.id,
        data: command,
        command: null
      }).catch(onError);
      // 面板卸载后再把焦点交回终端，否则敲字落在已移除的输入框上
      requestAnimationFrame(() =>
        session.terminal.focus()
      );
    },
    [onError]
  );

  // ---- 窗格（多标签组网格），状态与操作见 paneGrid ----
  const pane = usePaneGrid();
  const {
    panes,
    setPanes,
    panesRef,
    tree,
    treeRef,
    setTreeAndSync,
    activePane,
    activePaneIdRef,
    activePaneRef,
    paneHostRefs,
    setPaneHost,
    activateTab,
    activatePaneTab,
    moveTab,
    reorderTab,
    setPaneRatio,
    setActivePaneId
  } = pane;

  // ---- PTY 尺寸同步，机制见 ptyResize ----
  const {
    resize,
    resizeRef,
    schedulePtyResize,
    cancelPtyResize,
    pausePtySync,
    setPtyResizePaused,
    ptyResizeTimers,
    syncedSizes
  } = usePtyResizeSync({
    openedRef,
    disconnectedRef,
    panesRef
  });

  const resizeObserver = useRef<
    ResizeObserver | undefined
  >(undefined);
  // 终端右键菜单（命令式 DOM，逻辑见 terminalContextMenu）：
  // 首次用到时才创建，那时 openSearch 已经定义好。
  // 菜单只建一次，重连入口经 ref 转发，避免闭包锁死旧设置
  const terminalMenu = useRef<ReturnType<
    typeof createTerminalMenu
  > | null>(null);
  const reconnectRef = useRef(reconnectSession);
  useEffect(() => {
    reconnectRef.current = reconnectSession;
  }, [reconnectSession]);

  // 拖路径进终端（SFTP 窗口 → 主窗口），机制见 useTerminalPathDrop
  useTerminalPathDrop({ openedRef, panesRef });

  // 当前会话 = 活动窗格显示的那只。派生而非独立 state —— 两个真值
  // 来源迟早会打架（切了窗格但 activeId 还指着旧会话）。
  const activeId = activePane?.visibleId ?? "";
  const active = opened.find(
    s => s.id === activeId
  );
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const searchResult = search.results[
    activeId
  ] ?? {
    index: -1,
    count: 0
  };

  // 字体/字号/配色/补全开关/硬件加速与回滚行数的下发，机制见
  // useTerminalAppearance（含「字号变化要补一次 PTY 同步」的理由）
  useTerminalAppearance({
    appearance,
    openedRef,
    pausePtySync,
    resize
  });

  // panes/visibleId 变化后统一挂载/切换各窗格的终端。layout effect 在
  // commit 之后、浏览器绘制之前同步执行，此时宿主已由 ref 回调登记进
  // paneHostRefs，不会像手写 rAF 那样在 DOM 未更新时提前早退。
  // 直接用 state 闭包而非 ref：layout effect 先于同步 ref 的被动 effect 执行，
  // 读 ref 会拿到上一次提交的旧值。
  //
  // 每个窗格只挂自己 visibleId 那一只，其余标签的元素离树待命（与未激活
  // 标签同一套模式），切标签＝换挂 + 按窗格尺寸 fit。同一只会话只属于
  // 一个窗格，因此各窗格之间不会争夺同一个元素。
  useLayoutEffect(() => {
    for (const paneItem of panes) {
      const session = opened.find(
        s => s.id === paneItem.visibleId
      );
      const host = paneHostRefs.current.get(
        paneItem.id
      );
      if (!session || !host) continue;
      session.element.className =
        "terminal-instance";
      host.replaceChildren(session.element);
      const first = !session.mounted;
      if (first) {
        session.terminal.open(session.element);
        session.mounted = true;
      }
      // ⚠️ WebGL 必须在 open() 之后启用：addon 内部要往
      // `terminal.screenElement` 塞 canvas，而该元素 open() 时才创建。
      // 放在 `first` 之外是必要的 —— 设置里把硬件加速打开时，
      // 已存在的终端也要补上。enableWebgl 幂等，重复调用无副作用。
      // 失败时内部静默降级，这里不会中断挂载。
      enableWebgl(session.terminal);
      resizeObserver.current?.observe(host);
      resize(session);
      // 只让活动窗格抢键盘焦点：挂载时顺带 focus 活动那只，
      // 其余窗格保持安静（否则新开一个窗格会把正在输入的那只抢走）
      if (paneItem.id === activePane?.id)
        session.terminal.focus();
    }
    // ⚠️ 依赖里带 appearance.webglRender：设置里把硬件加速**打开**时，
    // 已存在的终端要在这里补一次 enableWebgl（它幂等，重复调用无副作用）；
    // 关掉时由上面那个外观 effect 里的 setWebglEnabled 统一释放。
  }, [
    opened,
    panes,
    activePane?.id,
    resize,
    paneHostRefs,
    appearance.webglRender
  ]);

  // ---- 终端实例组装（见 terminalCreate） ----
  const ensureTerminalMenu = useCallback(() => {
    terminalMenu.current ??= createTerminalMenu({
      onError,
      onFind: search.openSearch,
      onHistory: openHistorySearch,
      // 右键「粘贴」与剪贴板粘贴同一条路径，但它是**我们发起**的，
      // 没有原生插入垫底 —— 安全内容必须由 requestPaste 自己补 paste
      onPaste: (sessionId, text) =>
        requestPaste(sessionId, text, {
          inserted: false
        }),
      onReconnect: id => reconnectRef.current(id)
    });
    return terminalMenu.current;
  }, [
    onError,
    search.openSearch,
    openHistorySearch,
    requestPaste
  ]);

  const createTerminal = useCallback(
    (
      session: SavedSession,
      sourceSessionId: string,
      execTarget: SshTarget
    ): OpenSession =>
      createTerminalInstance(
        session,
        sourceSessionId,
        {
          appearance,
          execTarget,
          onError,
          onFontSizeChange,
          isDisconnected: () =>
            Boolean(
              disconnectedRef.current[session.id]
            ),
          reportSearchResults:
            search.reportResults,
          openSearch: search.openSearch,
          openHistorySearch,
          // 绑定到本会话：组件层只上报「有人粘了这段」+ 粘贴前的输入行
          requestPaste: (text, before) =>
            requestPaste(session.id, text, {
              before
            }),
          // 失败即诊断：只在 D 标记给出非零退出码时上报现场
          onCommandFailure: failure =>
            handleCommandFailure(
              session.id,
              failure
            ),
          onCommandSuccess: () =>
            clearFailure(session.id),
          ensureTerminalMenu,
          formatFontSizeHint: size =>
            t("terminal.fontSizeHint", { size }),
          onLongCommand
        }
      ),
    [
      appearance,
      onError,
      onFontSizeChange,
      search.reportResults,
      search.openSearch,
      openHistorySearch,
      requestPaste,
      handleCommandFailure,
      clearFailure,
      ensureTerminalMenu,
      t,
      onLongCommand
    ]
  );

  // ---- 会话生命周期（开/复制/密码补验），见 useTerminalSessions ----
  const {
    passwordRequest,
    submitPassword,
    useKeyAuth,
    cancelPassword,
    startSession,
    open,
    duplicate,
    nextDupName
  } = useTerminalSessions({
    createTerminal,
    setOpened,
    openedRef,
    setDisconnected,
    disconnectedRef,
    activePaneRef,
    panesRef,
    setPanes,
    activateTab,
    syncedSizes,
    schedulePtyResize,
    onError,
    onSavePassword,
    sshKeyPath: appearance.sshKeyPath,
    useSshConfig: appearance.useSshConfig,
    hostKeyPolicy: appearance.hostKeyPolicy,
    sessions
  });

  // ---- 会话关闭与窗格拆分（树手术 + PTY 同步挂起），
  // 见 useTerminalPaneOps ----
  const {
    splitPaneBy,
    focusTerminal,
    close,
    closeMany
  } = useTerminalPaneOps({
    openedRef,
    setOpened,
    disconnectedRef,
    treeRef,
    setTreeAndSync,
    panesRef,
    setPanes,
    activePaneRef,
    activePaneIdRef,
    setActivePaneId,
    cancelReconnect,
    cancelPtyResize,
    pausePtySync,
    resizeRef,
    startSession,
    nextDupName,
    onError
  });

  // ---- 全局监听（输出/退出事件、终端层快捷键、ResizeObserver、
  // 卸载清理），机制与搬迁理由见 useTerminalGlobalListeners ----
  useTerminalGlobalListeners({
    openedRef,
    disconnectedRef,
    setDisconnected,
    resizeObserverRef: resizeObserver,
    resizeRef,
    ptyResizeTimers,
    handleDisconnect,
    cancelAllReconnects,
    search,
    t
  });

  return {
    opened,
    activeId,
    active,
    disconnected,
    /** 手动重连（断线后右键终端里的「重新连接」） */
    reconnect: reconnectSession,
    open,
    duplicate,
    activate: activateTab,
    focusTerminal,
    close,
    closeMany,
    setPtyResizePaused,
    /** 强制所有窗格重新按当前容器尺寸 fit。
     *  AI 面板开合这类「宿主宽度突变」的场景要主动调 —— 见
     *  TerminalWorkspace 里的补 fit effect。 */
    resize,
    /** 挂起 PTY 尺寸同步（默认 600ms 后解除并补一次全量同步）。
     *  AI 面板开合时先调它：把尺寸变化挡在 ConPTY 重绘之外，
     *  否则屏幕上方内容会被整屏重发挤掉。 */
    pausePtySync,
    // ---- 窗格网格 ----
    panes,
    tree,
    activePaneId: activePane?.id ?? "",
    setPaneHost,
    setPaneRatio,
    splitPane: splitPaneBy,
    activatePaneTab,
    setActivePaneId: setActivePaneId,
    moveTab,
    reorderTab,
    passwordRequest,
    submitPassword,
    useKeyAuth,
    cancelPassword,
    // 查找相关的状态与操作都来自 useTerminalSearch
    searchOpen: search.searchOpen,
    searchError: search.searchError,
    searchResult,
    searchCaseSensitive:
      search.searchCaseSensitive,
    searchRegex: search.searchRegex,
    openSearch: search.openSearch,
    closeSearch: search.closeSearch,
    toggleCaseSensitive:
      search.toggleCaseSensitive,
    toggleRegex: search.toggleRegex,
    search: search.search,
    // ---- 命令历史检索面板 ----
    historyOpen,
    /** 当前会话的主机标识：面板默认只看本机（可切到跨主机） */
    historyHost: active ? hostKeyOf(active) : "",
    openHistorySearch,
    closeHistorySearch,
    insertHistory,
    // ---- 粘贴防护 ----
    pasteRequest,
    confirmPaste,
    cancelPaste,
    // ---- 失败即诊断 ----
    failures,
    diagnoseFailure,
    clearFailure
  };
}
