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
import type { SavedSession } from "@/sessions/lib/session";
import { useT } from "@/settings/lib/i18n";
import { enableWebgl } from "@/terminal/lib/webglRenderer";
import { createTerminalMenu } from "@/terminal/lib/terminalContextMenu";
import { useTerminalSearch } from "@/terminal/lib/search/useTerminalSearch";
import { useTerminalReconnect } from "./useTerminalReconnect";
import type { OpenSession } from "./terminalTypes";
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
  onFontSizeChange: (fontSize: number) => void
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
    onError
  });

  // 查找能力（搜索框开关、高亮与结果计数），内部自带状态
  const search = useTerminalSearch(
    openedRef,
    activeIdRef
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
      onReconnect: id => reconnectRef.current(id)
    });
    return terminalMenu.current;
  }, [onError, search.openSearch]);

  const createTerminal = useCallback(
    (
      session: SavedSession,
      sourceSessionId: string
    ): OpenSession =>
      createTerminalInstance(
        session,
        sourceSessionId,
        {
          appearance,
          onError,
          onFontSizeChange,
          isDisconnected: () =>
            Boolean(
              disconnectedRef.current[session.id]
            ),
          reportSearchResults:
            search.reportResults,
          openSearch: search.openSearch,
          ensureTerminalMenu,
          formatFontSizeHint: size =>
            t("terminal.fontSizeHint", { size })
        }
      ),
    [
      appearance,
      onError,
      onFontSizeChange,
      search.reportResults,
      search.openSearch,
      ensureTerminalMenu,
      t
    ]
  );

  // ---- 会话生命周期（开/复制/密码补验），见 useTerminalSessions ----
  const {
    passwordRequest,
    submitPassword,
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
    onSavePassword
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
    search: search.search
  };
}
