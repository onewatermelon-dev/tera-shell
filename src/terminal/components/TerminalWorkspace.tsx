import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type {
  OpenSession,
  PaneState
} from "@/terminal/lib/useTerminals";
import type {
  PaneNode,
  SplitDirection
} from "@/terminal/lib/paneLayout";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Surface,
  ToggleButton,
  Typography
} from "@heroui/react";
import Hint from "@/shared/components/Hint";
import AiPanel from "@/terminal/components/AiPanel";
import MacroBar from "@/terminal/components/MacroBar";
import StatusInfoBar from "@/terminal/components/StatusInfoBar";
import SystemInfoDrawer from "@/terminal/components/SystemInfoDrawer";
import ProcessInfoDrawer from "@/terminal/components/ProcessInfoDrawer";
import NetworkInfoDrawer from "@/terminal/components/NetworkInfoDrawer";
import PaneGrid from "@/terminal/components/PaneGrid";
import PaneTabBar from "@/terminal/components/PaneTabBar";
import TabContextMenu, {
  type TabAction
} from "@/terminal/components/TabContextMenu";
import { useT } from "@/settings/lib/i18n";
import type { StatusMode } from "@/settings/lib/settings";
import type { TerminalMacro } from "@/terminal/lib/terminalMacros";
import {
  loadPanelWidth,
  savePanelWidth
} from "@/terminal/lib/aiPrefs";
import {
  PlusOutlined,
  DesktopOutlined,
  LeftOutlined,
  LinkOutlined
} from "@ant-design/icons";

type Props = {
  opened: OpenSession[];
  active?: OpenSession;
  disconnected: Record<string, boolean>;
  searchOpen: boolean;
  searchResult: { index: number; count: number };
  searchError: string;
  searchCaseSensitive: boolean;
  searchRegex: boolean;
  onClose: (id: string) => void;
  /** 批量关闭多个会话（标签右键菜单：关闭右侧/其他/所有）。 */
  onCloseTabs: (ids: string[]) => void;
  onCreate: () => void;
  /** 打开本地终端：空状态里的次要操作。 */
  onOpenLocal: () => void;
  /** 把键盘焦点交回指定会话的终端（点标签/窗格后调用）。 */
  onFocusTerminal: (id: string) => void;
  /** 强制所有窗格重新按当前容器尺寸 fit（AI 面板开合后要补一次）。 */
  onResize: () => void;
  /** 挂起 PTY 尺寸同步 600ms 且**不补同步**
   *  （AI 面板开合时防 ConPTY 整屏重发丢内容）。 */
  onPausePtySync: () => void;
  onSearch: (
    query: string,
    direction: "next" | "prev" | "input"
  ) => void;
  onCloseSearch: () => void;
  onToggleCaseSensitive: () => void;
  onToggleRegex: () => void;
  // ---- 窗格网格 ----
  /** 每个窗格的标签组与当前显示的会话 */
  panes: PaneState[];
  /** 窗格布局树（行列方向与比例，见 paneLayout.ts） */
  tree: PaneNode;
  /** 当前活动窗格：焦点、选中胶囊、宏执行目标都跟着它 */
  activePaneId: string;
  /** 注册窗格宿主（终端元素命令式挂进去，React 不感知） */
  onPaneHost: (
    paneId: string,
    el: HTMLElement | null
  ) => void;
  /** 点窗格内部：把它设为活动窗格 */
  onFocusPane: (paneId: string) => void;
  /** 点某窗格内的标签：切该窗格显示的会话 */
  onActivatePaneTab: (
    paneId: string,
    id: string
  ) => void;
  /** 拖分隔条：按分割节点 id 写回比例 */
  onPaneRatio: (
    splitId: string,
    ratio: number
  ) => void;
  /** 拆分窗格：向右 / 向下。返回新会话 id（失败 undefined） */
  onSplitPane: (
    paneId: string,
    direction: SplitDirection
  ) => Promise<string | undefined>;
  /** 拖标签在窗格之间搬移 */
  onMoveTab: (
    id: string,
    toPaneId: string
  ) => void;
  /** 窗格内拖拽换位：插到 beforeId 之前，null 表示末尾 */
  onReorderTab: (
    paneId: string,
    id: string,
    beforeId: string | null
  ) => void;
  /** 快捷宏列表。 */
  macros: TerminalMacro[];
  /** 点击某个宏：在当前聚焦的窗格（左栏或某个拆分栏）里执行它的命令。 */
  onRunMacro: (
    macro: TerminalMacro,
    targetId: string
  ) => void;
  /** 点击 + ：弹出新增快捷宏的窗口。 */
  onAddMacro: () => void;
  /** AI 执行卡片「存为宏」：名称用卡片说明文字，留空由宏层兜底用命令。 */
  onAddMacroCommand: (
    name: string,
    command: string
  ) => void;
  /** 右键某个宏 → 编辑。 */
  onEditMacro: (macro: TerminalMacro) => void;
  /** 右键某个宏 → 删除。 */
  onDeleteMacro: (macro: TerminalMacro) => void;
  /** 拖拽宏按钮换位：把 id 插到 beforeId 之前（null = 末尾）。 */
  onReorderMacro: (
    id: string,
    beforeId: string | null
  ) => void;
  /** 底部状态栏形态：快捷宏 ⇆ 系统信息（竖条按钮切换）。 */
  statusMode: StatusMode;
  /** 信息形态下点击未开放入口（系统 / 进程 / 网络信息）的提示出口。 */
  onNotify: (message: string) => void;
  /** SSH 欢迎卡片开关（设置-终端）。 */
  welcomeCard: boolean;
  /** 暂停/恢复向 PTY 同步行高（系统信息抽屉开合期间只动本地视口）。 */
  setPtyResizePaused: (paused: boolean) => void;
};

export default function TerminalWorkspace({
  opened,
  active,
  disconnected,
  searchOpen,
  searchResult,
  searchError,
  searchCaseSensitive,
  searchRegex,
  onFocusTerminal,
  onResize,
  onPausePtySync,
  onClose,
  onCloseTabs,
  onCreate,
  onOpenLocal,
  onSearch,
  onCloseSearch,
  onToggleCaseSensitive,
  onToggleRegex,
  panes,
  tree,
  activePaneId,
  onPaneHost,
  onFocusPane,
  onActivatePaneTab,
  onPaneRatio,
  onSplitPane,
  onMoveTab,
  onReorderTab,
  macros,
  onRunMacro,
  onAddMacro,
  onAddMacroCommand,
  onEditMacro,
  onDeleteMacro,
  onReorderMacro,
  statusMode,
  onNotify,
  welcomeCard,
  setPtyResizePaused
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  // 标签右键菜单：记录触发位置、目标标签与所属窗格，null 表示不显示
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    paneId: string;
    canCloseRight: boolean;
  } | null>(null);
  const searchInputRef =
    useRef<HTMLInputElement>(null);

  /**
   * 每个窗格的标签列表：按 tabIds 顺序取会话。
   *
   * 必须 useMemo：每次渲染都给新数组的话，下游依赖它的 effect 每渲染
   * 都跑（渲染环），"把激活标签滚进可视区"会被带着每帧执行。
   */
  const paneSessions = useMemo(() => {
    const map = new Map<string, OpenSession[]>();
    for (const pane of panes) {
      map.set(
        pane.id,
        pane.tabIds
          .map(id =>
            opened.find(
              session => session.id === id
            )
          )
          .filter(
            (session): session is OpenSession =>
              Boolean(session)
          )
      );
    }
    return map;
  }, [opened, panes]);

  // 快捷宏的目标会话 = 活动窗格正在显示的那只（由 useTerminals 派生
  // 成 terminals.active），宏执行落在用户正对着的那一格
  const macroTargetId = active?.id;

  // 焦点回还：窗口重新抢回系统焦点、或点击终端区空白处时，只要用户
  // 没有明确在别处打字（AI 输入框 / 搜索框等文本控件），且设置页没开，
  // 就把键盘焦点交还给正对着的终端 —— 光标常亮闪烁，不用每次先点一下。
  const refocusTerminal = useCallback(() => {
    if (document.querySelector(".settings-page"))
      return;
    const el = document.activeElement;
    if (
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable)
    )
      return;
    if (macroTargetId)
      onFocusTerminal(macroTargetId);
  }, [macroTargetId, onFocusTerminal]);

  useEffect(() => {
    window.addEventListener(
      "focus",
      refocusTerminal
    );
    return () =>
      window.removeEventListener(
        "focus",
        refocusTerminal
      );
  }, [refocusTerminal]);

  /**
   * 拖标签在窗格之间搬移 / 窗格内换位。
   *
   * 原生 HTML5 拖放在 WebView2 里完全拖不动且不报错（本项目已踩过），
   * 所以手写 pointer 拖拽：按下记录候选，移动超阈值才进拖拽，松开时
   * 按落点判定。选中不在这里做 —— 选中挂在按下那一下（onSelect），
   * 挂到 click / 松手上会被手抖阈值和 preventDefault 吞掉。
   */
  function startTabDrag(
    event: ReactMouseEvent,
    fromPaneId: string,
    id: string
  ) {
    // 只响应主键；× 关闭钮自己会 stopPropagation，不会进到这里
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    const label =
      (
        event.currentTarget as HTMLElement
      ).textContent
        ?.replace("×", "")
        .trim() || "";

    const onMove = (ev: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(
          ev.clientX - startX,
          ev.clientY - startY
        ) > 6
      ) {
        dragging = true;
        document.body.classList.add(
          "tab-dragging"
        );
        ghost = document.createElement("div");
        ghost.className = "tab-drag-ghost";
        ghost.textContent = label;
        document.body.appendChild(ghost);
      }
      // 浮标中心对齐抓手：先移到指针位置，再回退自身一半宽高
      if (ghost)
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
      ev.preventDefault();
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener(
        "pointermove",
        onMove
      );
      window.removeEventListener(
        "pointerup",
        onUp
      );
      ghost?.remove();
      document.body.classList.remove(
        "tab-dragging"
      );
      // 没超阈值＝按下那一下已经完成选中，这里不搬动
      if (!dragging) return;
      ev.preventDefault();
      // elementFromPoint 拿落点元素（标签被拖走后 pointer 命中的是
      // 别的元素，不能用 ev.target）
      const under = document.elementFromPoint(
        ev.clientX,
        ev.clientY
      );
      // 落点标签条：data-pane-tabs 就是窗格 id。落在标签条上任意空白处
      // （+ 按钮、溢出按钮那一带）同样算"进这个窗格"
      const hit = under?.closest(
        "[data-pane-tabs]"
      );
      if (!hit) return;
      const toPaneId = hit.getAttribute(
        "data-pane-tabs"
      );
      if (!toPaneId) return;
      // 跨窗格＝搬移；同窗格＝换位
      if (toPaneId !== fromPaneId) {
        onMoveTab(id, toPaneId);
        onFocusPane(toPaneId);
        return;
      }
      // 落点标签：指针过中线就插到它后面（取它右边那个标签当锚点，
      // 没有就是末尾）；落在空白处（最后一个标签右侧）＝追加到末尾
      const el = under?.closest(
        "[data-pane-tab-id]"
      ) as HTMLElement | null;
      let beforeId: string | null = null;
      if (el) {
        const rect = el.getBoundingClientRect();
        const after =
          ev.clientX > rect.left + rect.width / 2;
        const anchor = el.getAttribute(
          "data-pane-tab-id"
        );
        const list =
          paneSessions.get(fromPaneId) ?? [];
        const index = list.findIndex(
          item => item.id === anchor
        );
        if (index >= 0)
          beforeId = after
            ? (list[index + 1]?.id ?? null)
            : anchor;
      }
      if (beforeId !== id)
        onReorderTab(fromPaneId, id, beforeId);
    };
    window.addEventListener(
      "pointermove",
      onMove
    );
    window.addEventListener("pointerup", onUp);
  }

  // 搜索框打开时自动聚焦全选
  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [searchOpen]);

  // 活动标签可能落在分隔条之外被裁掉（切窗格时尤其明显）。
  // 这里在活动会话变化后把它滚进可视区，保证"新开的标签自己会露出来"
  useEffect(() => {
    if (!active?.id) return;
    document
      .querySelector<HTMLElement>(
        `[data-pane-tab-id="${active.id}"]`
      )
      ?.scrollIntoView({
        block: "nearest",
        inline: "nearest"
      });
  }, [active?.id]);

  function toggleAndSearch(toggle: () => void) {
    toggle();
    onSearch(query, "input");
  }

  const searchCount = searchResult.count;
  const searchIndex = searchResult.index;

  // AI 面板可拖宽度：默认 390，最窄 320，最宽到终端区域的一半（见 max）
  // 底部抽屉：none / 系统信息 / 进程信息 / 网络信息
  const [bottomDrawer, setBottomDrawer] =
    useState<"none" | "sys" | "proc" | "net">(
      "none"
    );
  const drawerOpen = bottomDrawer !== "none";
  // SSH 欢迎卡片：ConPTY 整屏重绘会抹掉直写 xterm 的内容，
  // 欢迎说明只能做在终端缓冲之外的浮层上；记录已关闭的会话 id
  const [welcomeClosedFor, setWelcomeClosedFor] =
    useState<string | null>(null);
  // AI 面板收起状态：收起后贴窗口右缘成浮窗按钮
  const [aiCollapsed, setAiCollapsed] =
    useState(false);

  // 抽屉开合只缩/放本地视口，期间暂停向 PTY 同步行高：ConPTY 在 PTY
  // 尺寸变化时会整屏重绘，若把 PTY 缩到十几行再放大，重绘内容只剩那
  // 十几行，会把本地已恢复的历史打回空白（「先恢复、一闪又缩回去」）。
  // 本地视口的重新 fit 由 ResizeObserver 链路完成（暂停只挡后端同步）。
  // AI 面板收起/展开不在此列：cat 高亮块经 pts 输出注入，本就在 ConPTY
  // 缓冲里，正常同步尺寸即可。
  useEffect(() => {
    setPtyResizePaused(drawerOpen);
  }, [drawerOpen, setPtyResizePaused]);

  const [aiWidth, setAiWidth] = useState<number>(
    () => {
      // 最小宽度 390：旧存档里更小的值一并抬回来
      return Math.max(
        390,
        loadPanelWidth() ?? 390
      );
    }
  );

  /**
   * AI 面板开合：先挂起 PTY 同步、再补一次全量 fit。
   *
   * 两个动作缺一不可：
   *
   * 1. **挂起 PTY 同步**（`onPausePtySync`）：面板开合只是本地容器宽度变了，
   *    没必要惊动 ConPTY。一旦把新列数同步过去，会触发
   *    「ConPTY 整屏重发视口 + 远端 readline 重绘 + xterm reflow」三方叠加，
   *    屏幕内容被整屏重发挤掉 —— 表现为「开合 AI 助手后内容变少」（丢中段）。
   *    挂起期间只做本地 fit：显示立刻正确，缓冲不丢。
   *    ⚠️ 挂起**不补同步**（flush=false）：那次补同步本身就是丢内容的动作，
   *    而远端不需要知道新列数（本地 fit 已让显示正确）。
   *
   * 2. **等两帧再 fit**：rAF 保证 DOM 已更新，第二帧保证 grid 布局落定。
   *    面板收起时 `has-panel` 类被摘掉、面板整体卸载，列定义重排有中间态；
   *    只靠 ResizeObserver 常会命中中间态，按过期宽度算出列数。
   */
  useEffect(() => {
    onPausePtySync();
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        onResize();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [
    aiCollapsed,
    aiWidth,
    onResize,
    onPausePtySync
  ]);

  const aiHostRef = useRef<HTMLDivElement>(null);
  /** 拖拽开始时钉住容器矩形，避免拖动过程中重读布局 */
  const aiDragRef = useRef<DOMRect | null>(null);

  function startAiResize(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    const host = aiHostRef.current;
    if (!host) return;
    event.currentTarget.setPointerCapture(
      event.pointerId
    );
    aiDragRef.current =
      host.getBoundingClientRect();
  }

  function moveAiResize(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    const rect = aiDragRef.current;
    if (!rect) return;
    const min = 390;
    // 上限 = 容器一半（再减去分隔条 5px 与两条 4px 间隙）
    const max = (rect.width - 13) / 2;
    const next = Math.min(
      Math.max(min, rect.right - event.clientX),
      Math.max(min, max)
    );
    setAiWidth(Math.round(next));
  }

  function endAiResize() {
    aiDragRef.current = null;
    savePanelWidth(aiWidth);
  }

  return (
    // SSH 会话激活时右侧并排 AI 聊天面板（占位态），本地会话只有终端卡片
    <div
      ref={aiHostRef}
      className={
        active?.kind === "ssh" && !aiCollapsed
          ? "terminal-with-ai has-panel"
          : "terminal-with-ai"
      }
      style={
        {
          "--ai-panel-width": `${aiWidth}px`
        } as CSSProperties
      }
    >
      {/* HeroUI Card 面板：圆角 + surface 底色，p-0/gap-0 抵消 Card 内边距 */}
      <Card
        className={`terminal-pane rounded-xl p-0 gap-0 ${
          drawerOpen && active?.kind === "ssh"
            ? "has-sys-drawer"
            : ""
        } ${
          active?.kind === "local"
            ? "no-status"
            : ""
        }`}
      >
        {opened.length > 0 ? (
          /* 窗格网格：布局树递归渲染，每个叶子是一个窗格（自己的标签条
             + 自己的终端宿主）。窗格之间用可拖分隔条划分，行/列方向由
             树的 direction 决定。 */
          <div className="pane-grid">
            <PaneGrid
              node={tree}
              onRatio={onPaneRatio}
              renderLeaf={paneId => {
                const pane = panes.find(
                  item => item.id === paneId
                );
                if (!pane) return null;
                const sessions =
                  paneSessions.get(paneId) ?? [];
                const isActive =
                  paneId === activePaneId;
                return (
                  <div
                    key={paneId}
                    className="pane-cell"
                    data-pane-cell={paneId}
                  >
                    <PaneTabBar
                      paneId={paneId}
                      sessions={sessions}
                      visibleId={pane.visibleId}
                      active={isActive}
                      disconnected={disconnected}
                      // 「新建」只在第一个窗格显示：一排重复的 + 按钮
                      // 既占地方又让人不知道该点哪个
                      showCreate={
                        paneId === panes[0]?.id
                      }
                      onCreate={onCreate}
                      onSelect={id =>
                        onActivatePaneTab(
                          paneId,
                          id
                        )
                      }
                      onClose={onClose}
                      onContextMenu={(
                        ev,
                        session,
                        index
                      ) => {
                        ev.preventDefault();
                        const list =
                          paneSessions.get(
                            paneId
                          ) ?? [];
                        setTabMenu({
                          x: ev.clientX,
                          y: ev.clientY,
                          tabId: session.id,
                          paneId,
                          canCloseRight:
                            index <
                            list.length - 1
                        });
                      }}
                      onTabPointerDown={(
                        ev,
                        id
                      ) =>
                        startTabDrag(
                          ev,
                          paneId,
                          id
                        )
                      }
                    />
                    {/* 点进窗格把它设为活动窗格：键盘焦点、宏执行目标、
                        选中胶囊都跟着走 */}
                    <div
                      className="terminal-host"
                      {...{
                        "data-pane-host": paneId
                      }}
                      ref={el =>
                        onPaneHost(paneId, el)
                      }
                      onMouseDown={() => {
                        onFocusPane(paneId);
                        onFocusTerminal(
                          pane.visibleId
                        );
                      }}
                    ></div>
                  </div>
                );
              }}
            />
            {tabMenu && (
              <TabContextMenu
                x={tabMenu.x}
                y={tabMenu.y}
                canCloseRight={
                  tabMenu.canCloseRight
                }
                onClose={() => setTabMenu(null)}
                onAction={(action: TabAction) => {
                  const paneId = tabMenu.paneId;
                  const list =
                    paneSessions.get(paneId) ??
                    [];
                  const index = list.findIndex(
                    item =>
                      item.id === tabMenu.tabId
                  );
                  if (
                    action === "splitRight" ||
                    action === "splitDown"
                  ) {
                    // 拆的是被右键的那个标签（VSCode 行为）：
                    // 用它的配置新起独立会话，放进新窗格。
                    // 焦点不用在这里抢 —— 新窗格一挂载就会成为活动窗格，
                    // useTerminals 的挂载 effect 会 focus 那只会话
                    void onSplitPane(
                      paneId,
                      action === "splitRight"
                        ? "row"
                        : "column"
                    );
                    return;
                  }
                  const ids = list.map(
                    item => item.id
                  );
                  if (action === "close") {
                    onClose(tabMenu.tabId);
                  } else if (
                    action === "closeRight"
                  ) {
                    onCloseTabs(
                      ids.slice(index + 1)
                    );
                  } else if (
                    action === "closeOthers"
                  ) {
                    onCloseTabs(
                      ids.filter(
                        item =>
                          item !== tabMenu.tabId
                      )
                    );
                  } else {
                    // 关闭所有：本窗格的 + 其余窗格的
                    onCloseTabs(
                      opened.map(item => item.id)
                    );
                  }
                }}
              />
            )}
          </div>
        ) : (
          <EmptyState
            key="empty"
            className="empty-terminal"
          >
            {/* HeroUI Surface 做圆形图标底盘：空状态的视觉重心，
              比原先裸放的 42px 灰图标更有层次 */}
            <Surface className="empty-icon">
              <LinkOutlined />
            </Surface>
            <Typography.Heading
              level={3}
              className="empty-title"
            >
              {t("terminal.emptyTitle")}
            </Typography.Heading>
            <Typography.Paragraph
              size="sm"
              className="empty-desc"
            >
              {t("terminal.emptyDesc")}
            </Typography.Paragraph>
            <div className="empty-actions">
              <Button
                variant="primary"
                size="sm"
                onPress={onCreate}
              >
                <PlusOutlined />
                {t("terminal.newTab")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={onOpenLocal}
              >
                <DesktopOutlined />
                {t("app.menu.openLocal")}
              </Button>
            </div>
          </EmptyState>
        )}

        {welcomeCard &&
          active?.kind === "ssh" &&
          active.id !== welcomeClosedFor && (
            // SSH 欢迎卡片：钉在终端区顶部的浮层，手动关闭
            <div className="term-welcome">
              <button
                type="button"
                className="term-welcome-close"
                aria-label={t("app.action.close")}
                onClick={() =>
                  setWelcomeClosedFor(active.id)
                }
              >
                ×
              </button>
              <p>
                <span className="is-title">
                  ✓ Tera Shell 智能终端
                </span>{" "}
                <span className="is-gray">
                  AI Edition
                </span>{" "}
                ·{" "}
                <span className="is-red">
                  {active.username}@{active.host}:
                  {active.port}
                </span>
              </p>
              <p>
                ✓ 直接 SSH 连接 · 独立 exec
                执行通道 · AI 运维助手（右侧面板）
              </p>
              <p>
                ✓
                快捷命令解释：输入「命令/?」回车，如
                ls -a/?
              </p>
              <p>
                ✓ 系统 / 进程 /
                网络信息见底部状态栏 ·
                密码输入不回显
              </p>
              <p className="is-gray">
                💡 内容由 AI
                生成，执行前请仔细甄别
              </p>
            </div>
          )}

        {drawerOpen &&
          active?.kind === "ssh" &&
          (bottomDrawer === "sys" ? (
            <SystemInfoDrawer
              session={active}
              onClose={() =>
                setBottomDrawer("none")
              }
            />
          ) : bottomDrawer === "net" ? (
            <NetworkInfoDrawer
              session={active}
              onClose={() =>
                setBottomDrawer("none")
              }
            />
          ) : (
            <ProcessInfoDrawer
              session={active}
              onClose={() =>
                setBottomDrawer("none")
              }
            />
          ))}

        {/* 底部状态栏只在有活动的 SSH 会话时显示：本地会话用不到快捷宏与
            系统信息，没有任何会话时更不该挂着一条空栏 */}
        {active && active.kind !== "local" && (
          <div className="terminal-status">
            {/* 快捷宏挤在状态栏最前面：常驻可见，又不单独占一行 */}
            {statusMode === "info" ? (
              // 信息形态：左侧信息入口 + 右侧负载 / 网络，整组替换宏与 LOCAL/UTF-8
              <StatusInfoBar
                session={
                  active?.kind === "ssh"
                    ? active
                    : undefined
                }
                onNotify={onNotify}
                onOpenSystem={
                  active?.kind === "ssh"
                    ? () => setBottomDrawer("sys")
                    : undefined
                }
                onOpenProcess={
                  active?.kind === "ssh"
                    ? () =>
                        setBottomDrawer("proc")
                    : undefined
                }
                onOpenNetwork={
                  active?.kind === "ssh"
                    ? () => setBottomDrawer("net")
                    : undefined
                }
                activeEntry={
                  bottomDrawer === "sys"
                    ? "system"
                    : bottomDrawer === "proc"
                      ? "process"
                      : bottomDrawer === "net"
                        ? "network"
                        : undefined
                }
              />
            ) : (
              <>
                <MacroBar
                  macros={macros}
                  disabled={
                    !macroTargetId ||
                    disconnected[
                      macroTargetId
                    ] === true
                  }
                  onRun={macro => {
                    if (macroTargetId)
                      onRunMacro(
                        macro,
                        macroTargetId
                      );
                  }}
                  onAdd={onAddMacro}
                  onEdit={onEditMacro}
                  onDelete={onDeleteMacro}
                  onReorder={onReorderMacro}
                />
                {/* 状态文字单独成组并禁止收缩：宏再多也不会被顶出可视区 */}
                <div className="status-meta">
                  <span>
                    {active?.kind === "ssh"
                      ? "SSH"
                      : "LOCAL"}
                  </span>
                  <span>UTF-8</span>
                  <span>
                    {active?.terminal.cols || 0} ×{" "}
                    {active?.terminal.rows || 0}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {searchOpen && (
          // HeroUI Surface：查找浮层的底色/描边/阴影跟随主题 token
          <Surface className="find-box">
            <Input
              ref={searchInputRef}
              className="find-input"
              placeholder={t(
                "terminal.find.placeholder"
              )}
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                onSearch(e.target.value, "input");
              }}
              onKeyDown={e => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey
                ) {
                  e.preventDefault();
                  onSearch(query, "next");
                }
                if (
                  e.key === "Enter" &&
                  e.shiftKey
                ) {
                  e.preventDefault();
                  onSearch(query, "prev");
                }
                if (e.key === "Escape")
                  onCloseSearch();
              }}
            />
            <span className="find-count">
              {searchError ||
                (searchCount
                  ? `${searchIndex + 1}/${searchCount}`
                  : query
                    ? t("terminal.find.noMatch")
                    : "")}
            </span>
            <Hint label={t("terminal.find.prev")}>
              <Button
                className="find-btn"
                variant="tertiary"
                size="sm"
                aria-label={t(
                  "terminal.find.prev"
                )}
                onPress={() =>
                  onSearch(query, "prev")
                }
              >
                ↑
              </Button>
            </Hint>
            <Hint label={t("terminal.find.next")}>
              <Button
                className="find-btn"
                variant="tertiary"
                size="sm"
                aria-label={t(
                  "terminal.find.next"
                )}
                onPress={() =>
                  onSearch(query, "next")
                }
              >
                ↓
              </Button>
            </Hint>
            <Hint
              label={t(
                "terminal.find.caseSensitive"
              )}
            >
              <ToggleButton
                className="find-btn"
                variant="ghost"
                size="sm"
                aria-label={t(
                  "terminal.find.caseSensitive"
                )}
                isSelected={searchCaseSensitive}
                onChange={() =>
                  toggleAndSearch(
                    onToggleCaseSensitive
                  )
                }
              >
                Aa
              </ToggleButton>
            </Hint>
            <Hint
              label={t("terminal.find.regex")}
            >
              <ToggleButton
                className="find-btn"
                variant="ghost"
                size="sm"
                aria-label={t(
                  "terminal.find.regex"
                )}
                isSelected={searchRegex}
                onChange={() =>
                  toggleAndSearch(onToggleRegex)
                }
              >
                .*
              </ToggleButton>
            </Hint>
            <Hint
              label={t("terminal.find.close")}
            >
              <Button
                className="find-btn"
                variant="tertiary"
                size="sm"
                aria-label={t(
                  "terminal.find.close"
                )}
                onPress={onCloseSearch}
              >
                ×
              </Button>
            </Hint>
          </Surface>
        )}
      </Card>
      {active?.kind === "ssh" && !aiCollapsed && (
        <div
          className="ai-resizer"
          aria-hidden="true"
          onPointerDown={startAiResize}
          onPointerMove={moveAiResize}
          onPointerUp={endAiResize}
        />
      )}
      {active?.kind === "ssh" && (
        // AI 助手面板：对话 + run_command 执行卡片（只读自动执行、读写等确认）
        <AiPanel
          collapsed={aiCollapsed}
          session={active}
          onAddMacroCommand={onAddMacroCommand}
          onCollapse={() => setAiCollapsed(true)}
        />
      )}
      {active?.kind === "ssh" && aiCollapsed && (
        // 收起后的浮窗按钮：贴窗口右缘，点击向左拉回面板
        <button
          type="button"
          className="ai-reopen-tab"
          aria-label={t("ai.expand")}
          title={t("ai.expand")}
          onClick={() => setAiCollapsed(false)}
        >
          <LeftOutlined />
        </button>
      )}
    </div>
  );
}
