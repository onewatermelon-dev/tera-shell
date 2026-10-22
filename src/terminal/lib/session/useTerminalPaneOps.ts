/**
 * 终端会话操作：关闭/批量关闭、拆分窗格、焦点交回。
 *
 * 从 useTerminals 搬出（2026-10-14 拆分）。这四个操作都是「树手术」：
 * 改窗格布局树（setTreeAndSync）+ 改标签记录（setPanes）+ 起停 PTY，
 * 且都踩过同一族坑——**父容器尺寸突变时必须挂起 PTY 同步**（否则
 * ConPTY 整屏重发把屏幕内容挤掉），并补两帧 rAF 的显式 fit
 * （ResizeObserver 会命中「尺寸没定」的中间态）。详见各函数内注释。
 */
import { logError } from "@/shared/lib/log";
import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import { disableWebgl } from "@/terminal/lib/webglRenderer";
import {
  hasLeaf,
  removePane,
  splitPane,
  type PaneNode,
  type SplitDirection
} from "@/terminal/lib/pane/paneLayout";
import type { OpenSession } from "./terminalTypes";
import type { PaneState } from "./paneGrid";

export function useTerminalPaneOps(options: {
  openedRef: RefObject<OpenSession[]>;
  setOpened: Dispatch<
    SetStateAction<OpenSession[]>
  >;
  disconnectedRef: RefObject<
    Record<string, boolean>
  >;
  treeRef: RefObject<PaneNode>;
  setTreeAndSync: (
    updater: (prev: PaneNode) => PaneNode
  ) => void;
  panesRef: RefObject<PaneState[]>;
  setPanes: Dispatch<SetStateAction<PaneState[]>>;
  activePaneRef: RefObject<PaneState | undefined>;
  activePaneIdRef: RefObject<string>;
  setActivePaneId: Dispatch<
    SetStateAction<string>
  >;
  cancelReconnect: (id: string) => void;
  cancelPtyResize: (id: string) => void;
  pausePtySync: (
    settleMs?: number,
    flush?: boolean
  ) => void;
  resizeRef: RefObject<
    (current?: OpenSession) => void
  >;
  /** 起会话（来自 useTerminalSessions）：拆分复用它新起独立 PTY */
  startSession: (
    session: SavedSession & { password?: string },
    sourceSessionId: string,
    activate?: boolean
  ) => Promise<boolean>;
  /** 复制/拆分共用的命名（来自 useTerminalSessions） */
  nextDupName: (base: string) => string;
  onError: (reason: unknown) => void;
}) {
  const {
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
  } = options;

  /**
   * 拆分窗格（VSCode 式）。
   *
   * @param paneId 被拆的窗格；缺省为活动窗格
   * @param direction `row` 向右、`column` 向下
   * @param id       被复制的会话；缺省取被拆窗格当前显示的那只
   * @returns 新会话 id（失败为 undefined），调用方用它聚焦新标签
   *
   * 用被拆会话的配置新起一个独立会话（独立 PTY）放进**新建的窗格**，
   * 并立刻显示它。已被拆过的会话可以再拆（每次都新开窗格）。
   */
  const splitPaneBy = useCallback(
    async (
      paneId: string,
      direction: SplitDirection,
      id?: string
    ) => {
      try {
        if (!hasLeaf(treeRef.current, paneId))
          return undefined;
        const current = openedRef.current.find(
          s =>
            s.id ===
            (id ??
              activePaneRef.current?.visibleId)
        );
        // 已断开的会话拆出去也只是一块死屏，不开新窗格
        if (
          !current ||
          disconnectedRef.current[current.id]
        )
          return undefined;
        // 只取会话定义字段（密码若是明文直接复用，不再弹密码框）；
        // 运行时字段（terminal/element 等）不能进后端 config
        const stamp = Date.now();
        const config: SavedSession = {
          id: `split-${current.id}-${stamp}`,
          name: nextDupName(current.name),
          kind: current.kind,
          host: current.host,
          port: current.port,
          username: current.username,
          password: current.password
        };
        const ok = await startSession(
          config,
          current.sourceSessionId,
          false
        );
        if (!ok) return undefined;
        const newPaneId = `pane-${stamp}`;
        // ⚠️ **拆分也必须挂起 PTY 同步**（此前漏掉，只有 AI 面板开合和
        // 窗格折叠挂了）。拆分让被拆会话的行数骤减（实测 35 → 17 行），
        // xterm 会因此做一次 reflow（行合并）——**丢的是屏幕显示的中段，
        // 缓冲行数不变**（日志 `resize 后缓冲 35 → 35 行`），所以只看
        // 缓冲行数是查不出来的。而同步给 PTY 会再招来一轮 ConPTY 重发，
        // 与 reflow 错位叠加。远端不需要知道新行数：本地 fit 已让显示正确。
        pausePtySync(600);
        // 同 close 里的折叠：拆分也是父容器 grid 行轨变化 + 新宿主插入，
        // ResizeObserver 容易只命中中间态 → 两帧 rAF 补一次显式 fit
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resizeRef.current();
          });
        });
        // 先落布局再落标签：setTreeAndSync 会给新 paneId 补一条空记录，
        // 紧接着这次 setPanes 才把新标签写进去
        setTreeAndSync(prev =>
          splitPane(
            prev,
            paneId,
            direction,
            newPaneId,
            `split-${stamp}`
          )
        );
        setPanes(prev =>
          prev.map(p =>
            p.id === newPaneId
              ? {
                  ...p,
                  tabIds: [config.id],
                  visibleId: config.id
                }
              : p
          )
        );
        setActivePaneId(newPaneId);
        console.info(
          `[terminal] 拆分窗格 ${paneId} → ${newPaneId}（${direction}）`
        );
        // 返回新会话 id：调用方要用它聚焦 —— 新 id 是 split-…，
        // 拿被拆会话的 id 选中会让胶囊留在原窗格
        return config.id;
      } catch (error) {
        // 拆分失败要露出完整错误（含 TypeError 堆栈摘要），否则用户只看到
        // 毫无线索的气泡甚至毫无反应
        logError(
          "[terminal] 拆分窗格失败",
          error
        );
        onError(error);
      }
      return undefined;
    },
    [
      nextDupName,
      onError,
      pausePtySync,
      setPanes,
      setTreeAndSync,
      startSession,
      treeRef,
      activePaneRef,
      resizeRef,
      setActivePaneId,
      openedRef,
      disconnectedRef
    ]
  );

  /**
   * 把键盘焦点交回指定会话的终端。
   *
   * 切换标签时挂载用的 layout effect 已经 focus 过一次，但 RAC 的 Tab 会在
   * press 阶段把焦点留在自己身上，且点击**已激活**的标签不会改变 activeId、
   * layout effect 根本不跑。两种情况下都需要由点击方显式抢回焦点。
   */
  const focusTerminal = useCallback(
    (id: string) => {
      openedRef.current
        .find(session => session.id === id)
        ?.terminal.focus();
    },
    [openedRef]
  );

  const close = useCallback(
    async (id: string) => {
      const index = openedRef.current.findIndex(
        session => session.id === id
      );
      if (index < 0) return;
      // 关掉标签就别再重连它：清掉等待中的退避定时器
      cancelReconnect(id);
      // 待发送的尺寸同步也没必要了
      cancelPtyResize(id);
      // 从所属窗格里摘掉这个标签；若它正可见，可见位交给剩下的第一只。
      // 摘完窗格空了 → 把窗格从布局树里折叠掉（树会少一级），
      // 但树里只剩一个窗格时不能折叠，否则变成空树。
      const owner = panesRef.current.find(p =>
        p.tabIds.includes(id)
      );
      let emptiedPaneId = "";
      if (owner) {
        const rest = owner.tabIds.filter(
          tab => tab !== id
        );
        emptiedPaneId =
          rest.length === 0 ? owner.id : "";
        setPanes(prev =>
          prev.map(p =>
            p.id === owner.id
              ? {
                  ...p,
                  tabIds: rest,
                  visibleId:
                    p.visibleId === id
                      ? (rest[0] ?? "")
                      : p.visibleId
                }
              : p
          )
        );
      }
      await invoke("terminal_close", {
        id
      }).catch(onError);
      const closing = openedRef.current[index];
      // 先摘 WebGL 再 dispose 终端：addon 的 canvas 由它自己管，
      // 终端先 dispose 的话 addon 会对已销毁的 screenElement 操作
      if (closing) {
        // 先摘掉挂在 window 上的监听（粘贴防护这类全局监听不会随
        // DOM 移除失效，留着会让每次粘贴都跑一遍已关闭会话的判断）
        closing.disposeListeners?.();
        disableWebgl(closing.terminal);
        closing.terminal.dispose();
      }
      setOpened(prev => {
        const next = prev.filter(
          s => s.id !== id
        );
        openedRef.current = next;
        return next;
      });
      // 折叠空窗格：放在 setOpened 之后。setPanes/setTree 都同步写了 ref，
      // 所以 setTreeAndSync 读到的 panesRef 已是摘掉标签后的那份 ——
      // 不会把幽灵标签复活
      if (
        emptiedPaneId &&
        panesRef.current.length > 1
      ) {
        const remaining = panesRef.current.filter(
          p => p.id !== emptiedPaneId
        );
        setTreeAndSync(prev =>
          removePane(prev, emptiedPaneId)
        );
        // 活动窗格被折叠掉了 → 活动权交给剩下的第一个
        if (
          activePaneIdRef.current ===
          emptiedPaneId
        ) {
          setActivePaneId(remaining[0]?.id ?? "");
        }
        console.info(
          `[terminal] 窗格 ${emptiedPaneId} 已空，折叠`
        );
        // 折叠会让兄弟窗格**突然变宽**（容器尺寸突变），ResizeObserver
        // 随即触发 resize。若把新列数同步给 PTY，ConPTY 会整屏重发视口，
        // 把屏幕内容挤掉 —— 与 AI 面板开合同一个病。
        // 折叠是纯布局变化，远端不需要知道新列数（本地 fit 已让显示正确），
        // 所以挂起同步、不补。
        pausePtySync(400);
        // ⚠️ **折叠也必须像 AI 面板开合那样补一次显式 fit**（此前漏掉）：
        // ResizeObserver 只在宿主自身尺寸变化时触发，而折叠是**父容器
        // grid 行/列定义变化 + 被折窗格的 DOM 被摘掉**，宿主会经过一个
        // 「尺寸没定」的中间态 → observer 常只命中中间态，之后不再触发，
        // 终端就停在旧的行数上（表现为内容被截断）。等两帧 rAF：
        // 第一帧 DOM 更新、第二帧布局落定，此时量到的才是最终尺寸。
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resizeRef.current();
          });
        });
      }
    },
    [
      onError,
      pausePtySync,
      setPanes,
      setTreeAndSync,
      cancelReconnect,
      cancelPtyResize,
      activePaneIdRef,
      panesRef,
      resizeRef,
      setActivePaneId,
      openedRef,
      setOpened
    ]
  );

  /**
   * 批量关闭多个会话。逐个走单个关闭流程（杀 PTY、dispose、移出列表）。
   * close 内部会把 activeId 切到相邻标签，React 会对循环中的中间状态
   * 做批处理，最终落在保留的标签上。
   */
  const closeMany = useCallback(
    async (ids: string[]) => {
      for (const id of ids) await close(id);
    },
    [close]
  );

  return {
    splitPaneBy,
    focusTerminal,
    close,
    closeMany
  };
}
