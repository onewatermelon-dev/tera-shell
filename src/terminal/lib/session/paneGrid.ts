/**
 * 窗格网格（多标签组）的状态与操作。
 *
 * 从 useTerminals.ts 拆出。panes 与 tree 分开存：
 * - panes：每个窗格有哪些标签、当前显示哪一个（**可变状态**）
 * - tree ：窗格怎么排（**布局**，纯数据，见 pane/paneLayout.ts）
 * 分开是因为「关掉一个标签」只动 panes，「折叠一个窗格」才动 tree，
 * 两者互不牵连，React 比较时也能各自短路。
 *
 * 拆分 = 用被拆会话的配置新起一个独立会话（独立 PTY，VSCode 式），
 * 不是同一 PTY 的镜像 —— 单 PTY 喂两个不同宽度的视图必然互相重排
 * （拖分隔线时提示行被重复推下去），独立 PTY 各管各的尺寸就没有这类
 * 问题。拖标签进别的窗格也能加标签；关掉标签就是关掉该会话。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  collectLeafIds,
  createLeaf,
  setSplitRatio,
  type PaneNode
} from "@/terminal/lib/pane/paneLayout";

/**
 * 一个窗格：它自己的一组标签 + 当前显示哪一个。
 *
 * 每个标签是一只**独立会话**（独立 PTY），窗格只负责决定「这一格里
 * 摆哪些标签、现在亮哪一只」。
 */
export type PaneState = {
  /** 与布局树里的叶子 paneId 对应 */
  id: string;
  /** 本窗格的标签（会话 id，按加入顺序） */
  tabIds: string[];
  /** 当前显示在这个窗格里的会话 id；空串表示本窗格没有标签 */
  visibleId: string;
};

/** 首个窗格的固定 id（拆分出来的新窗格用 `pane-<时间戳>`）。 */
export const FIRST_PANE_ID = "pane-1";

export function usePaneGrid() {
  const [panes, setPanesState] = useState<
    PaneState[]
  >([
    {
      id: FIRST_PANE_ID,
      tabIds: [],
      visibleId: ""
    }
  ]);
  const [tree, setTreeState] = useState<PaneNode>(
    createLeaf(FIRST_PANE_ID)
  );
  // 活动窗格：键盘焦点、选中胶囊、宏执行目标都跟着它走
  const [activePaneId, setActivePaneId] =
    useState(FIRST_PANE_ID);
  // 闭包里读活动窗格（close 折叠窗格时判断活动权要不要移交）
  const activePaneIdRef = useRef(activePaneId);
  useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  // ref 供闭包读最新值（split/close/输出监听里判断）
  const panesRef = useRef(panes);
  const setPanes = useCallback(
    (
      updater:
        | PaneState[]
        | ((prev: PaneState[]) => PaneState[])
    ) => {
      const next =
        typeof updater === "function"
          ? updater(panesRef.current)
          : updater;
      panesRef.current = next;
      setPanesState(next);
    },
    []
  );
  const treeRef = useRef(tree);
  const setTree = useCallback(
    (
      updater:
        PaneNode | ((prev: PaneNode) => PaneNode)
    ) => {
      const next =
        typeof updater === "function"
          ? updater(treeRef.current)
          : updater;
      treeRef.current = next;
      setTreeState(next);
    },
    []
  );
  /**
   * 改布局树，并同步维护 panes 里的窗格记录。
   *
   * 两侧必须一起动，否则会留下幽灵：树里新增的 paneId 若没有对应记录，
   * 标签条渲染不出来；被摘掉的窗格若记录还在，就有个永远不显示、
   * 也永远关不掉的空标签组。
   *
   * ⚠️ **不要把 setPanes 写进 setTree 的 updater 里**（踩过）：
   * updater 必须是纯函数 —— React 在 StrictMode 下会调用两次、在并发
   * 渲染下还可能用旧 state 重放。副作用包在里面会重复执行，且与调用方
   * 自己的 setPanes 竞争（同一次 close 里先摘标签、再折叠窗格，两次写
   * panes 会互相覆盖），表现为**窗格折叠后剩下的会话标签被清空**。
   *
   * 正确做法：在 updater **外面**算好新树，再按新树同步 panes。
   */
  const setTreeAndSync = useCallback(
    (updater: (prev: PaneNode) => PaneNode) => {
      const next = updater(treeRef.current);
      const ids = new Set(collectLeafIds(next));
      const kept = panesRef.current.filter(pane =>
        ids.has(pane.id)
      );
      const nextPanes = [...kept];
      for (const id of ids) {
        if (
          !nextPanes.some(pane => pane.id === id)
        ) {
          nextPanes.push({
            id,
            tabIds: [],
            visibleId: ""
          });
        }
      }
      setPanes(nextPanes);
      setTree(next);
    },
    [setPanes, setTree]
  );

  /** 活动窗格（组被整体关掉时自动回落到第一个）。 */
  const activePane =
    panes.find(
      pane => pane.id === activePaneId
    ) ?? panes[0];
  const activePaneRef = useRef(activePane);
  useEffect(() => {
    activePaneRef.current = activePane;
  }, [activePane]);

  /**
   * 窗格宿主：paneId → 元素。终端元素是命令式 replaceChildren 挂进去的，
   * React 不感知，所以宿主必须由调用方注册进来。
   */
  const paneHostRefs = useRef(
    new Map<string, HTMLElement>()
  );
  const setPaneHost = useCallback(
    (paneId: string, el: HTMLElement | null) => {
      if (el)
        paneHostRefs.current.set(paneId, el);
      else paneHostRefs.current.delete(paneId);
    },
    []
  );

  /**
   * 切换到某只会话：显示它所在窗格里的它，并把该窗格设为活动窗格。
   *
   * 叫 `activateTab` 而不是 `activate`：`open`/`startSession` 都有个叫
   * `activate` 的布尔参数，同名会被遮蔽，闭包里拿到的是 boolean。
   */
  const activateTab = useCallback(
    (id: string) => {
      setPanes(prev =>
        prev.map(pane =>
          pane.tabIds.includes(id)
            ? { ...pane, visibleId: id }
            : pane
        )
      );
      const owner = panesRef.current.find(pane =>
        pane.tabIds.includes(id)
      );
      if (owner) setActivePaneId(owner.id);
    },
    [setPanes]
  );

  /** 点某窗格内的标签：只切该窗格显示的会话，不抢活动窗格。 */
  const activatePaneTab = useCallback(
    (paneId: string, id: string) => {
      setPanes(prev =>
        prev.map(pane =>
          pane.id === paneId &&
          pane.tabIds.includes(id)
            ? { ...pane, visibleId: id }
            : pane
        )
      );
    },
    [setPanes]
  );

  /**
   * 拖标签在窗格之间移动：本质是 tabIds 成员关系的搬移。
   *
   * 进入目标窗格＝成为该窗格的新标签并立刻可见；离开时若它正可见，
   * 可见位交给该窗格剩下的第一只。会话只属于一个窗格，所以源窗格必然
   * 要把它摘掉 —— 若那是源窗格最后一个标签，源窗格就地折叠（见 close）。
   */
  const moveTab = useCallback(
    (id: string, toPaneId: string) => {
      const from = panesRef.current.find(pane =>
        pane.tabIds.includes(id)
      );
      if (!from) return;
      if (from.id === toPaneId) return;
      if (
        !panesRef.current.some(
          pane => pane.id === toPaneId
        )
      )
        return;
      setPanes(prev =>
        prev.map(pane => {
          if (pane.id === from.id) {
            const tabIds = pane.tabIds.filter(
              tab => tab !== id
            );
            return {
              ...pane,
              tabIds,
              visibleId:
                pane.visibleId === id
                  ? (tabIds[0] ?? "")
                  : pane.visibleId
            };
          }
          if (pane.id === toPaneId) {
            return {
              ...pane,
              tabIds: [...pane.tabIds, id],
              visibleId: id
            };
          }
          return pane;
        })
      );
      console.info(
        `[terminal] 标签 ${id} 从窗格 ${from.id} 移到 ${toPaneId}`
      );
    },
    [setPanes]
  );

  /**
   * 窗格内拖拽换位：把 id 插到 beforeId 之前，beforeId 为 null 表示
   * 追加到末尾（拖到最后一个标签右侧的空白处）。
   *
   * 只动这个窗格的 tabIds —— 标签顺序是**每窗格各自**的，与 opened
   * 的全局顺序无关（opened 只是"哪些会话开着"的清单）。
   */
  const reorderTab = useCallback(
    (
      paneId: string,
      id: string,
      beforeId: string | null
    ) => {
      const pane = panesRef.current.find(
        item => item.id === paneId
      );
      if (!pane) return;
      const from = pane.tabIds.indexOf(id);
      if (from < 0) return;
      const next = [...pane.tabIds];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      const to =
        beforeId === null
          ? next.length
          : next.indexOf(beforeId);
      if (to < 0) return;
      next.splice(to, 0, moved);
      setPanes(prev =>
        prev.map(item =>
          item.id === paneId
            ? { ...item, tabIds: next }
            : item
        )
      );
    },
    [setPanes]
  );

  /**
   * 拖分隔条：按 splitId 写回比例。树的操作是纯函数（paneLayout），
   * 这里只负责把新树塞进 state。
   */
  const setPaneRatio = useCallback(
    (splitId: string, ratio: number) => {
      setTree(prev =>
        setSplitRatio(prev, splitId, ratio)
      );
    },
    [setTree]
  );

  return {
    panes,
    setPanes,
    panesRef,
    tree,
    setTree,
    treeRef,
    setTreeAndSync,
    activePaneId,
    setActivePaneId,
    activePaneIdRef,
    activePane,
    activePaneRef,
    paneHostRefs,
    setPaneHost,
    activateTab,
    activatePaneTab,
    moveTab,
    reorderTab,
    setPaneRatio
  };
}
