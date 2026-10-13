import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties
} from "react";
import type {
  OpenSession,
  PaneState
} from "@/terminal/lib/session/useTerminals";
import type {
  PaneNode,
  SplitDirection
} from "@/terminal/lib/pane/paneLayout";
import { Card } from "@heroui/react";
import AiPanel from "@/terminal/components/ai/AiPanel";
import { useAiPanelLayout } from "@/terminal/components/ai/useAiPanelLayout";
import PaneGrid from "@/terminal/components/pane/PaneGrid";
import PaneTabBar from "@/terminal/components/pane/PaneTabBar";
import TabContextMenu, {
  type TabAction
} from "@/terminal/components/pane/TabContextMenu";
import {
  BottomDrawer,
  type BottomDrawerMode
} from "@/terminal/components/drawers/BottomDrawer";
import { EmptyTerminal } from "@/terminal/components/workspace/EmptyTerminal";
import { FindBox } from "@/terminal/components/workspace/FindBox";
import { TerminalStatus } from "@/terminal/components/workspace/TerminalStatus";
import { WelcomeCard } from "@/terminal/components/workspace/WelcomeCard";
import { startTabDrag } from "@/terminal/lib/pane/tabDrag";
import { useTerminalRefocus } from "@/terminal/lib/session/useTerminalRefocus";
import { useT } from "@/settings/lib/i18n";
import type { StatusMode } from "@/settings/lib/settings";
import type { TerminalMacro } from "@/terminal/lib/macro/terminalMacros";
import { LeftOutlined } from "@ant-design/icons";

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
   * （AI 面板开合时防 ConPTY 整屏重发丢内容）。 */
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

/**
 * 终端工作区：窗格网格 + AI 面板 + 底部状态栏 + 查找浮层的装配层。
 *
 * 2026-10-13 拆分：标签拖拽去 lib/pane/tabDrag.ts，焦点回还去
 * lib/session/useTerminalRefocus.ts，AI 面板布局（宽度/收起/浮窗
 * 位置）去 components/ai/useAiPanelLayout.ts；查找浮层、空状态、
 * 欢迎卡片、底部抽屉与状态栏各自成组件（components/workspace、
 * components/drawers）。本文件只留 props 编排与网格装配。
 */
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

  // 窗口抢回焦点 / 点终端空白处：焦点回还给正对着的终端
  useTerminalRefocus(
    macroTargetId,
    onFocusTerminal
  );

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

  // 底部抽屉：none / 系统信息 / 进程信息 / 网络信息
  const [bottomDrawer, setBottomDrawer] =
    useState<BottomDrawerMode>("none");
  const drawerOpen = bottomDrawer !== "none";
  // SSH 欢迎卡片：记录已关闭的会话 id
  const [welcomeClosedFor, setWelcomeClosedFor] =
    useState<string | null>(null);

  // 抽屉开合只缩/放本地视口，期间暂停向 PTY 同步行高：ConPTY 在 PTY
  // 尺寸变化时会整屏重绘，若把 PTY 缩到十几行再放大，重绘内容只剩那
  // 十几行，会把本地已恢复的历史打回空白（「先恢复、一闪又缩回去」）。
  // 本地视口的重新 fit 由 ResizeObserver 链路完成（暂停只挡后端同步）。
  // AI 面板收起/展开不在此列：cat 高亮块经 pts 输出注入，本就在 ConPTY
  // 缓冲里，正常同步尺寸即可。
  useEffect(() => {
    setPtyResizePaused(drawerOpen);
  }, [drawerOpen, setPtyResizePaused]);

  // AI 面板布局：宽度 / 收起态 / 收起浮窗位置（含各自的拖拽与持久化）
  const {
    aiHostRef,
    aiWidth,
    aiCollapsed,
    setAiCollapsed,
    reopenTop,
    startAiResize,
    moveAiResize,
    endAiResize,
    startReopenDrag,
    moveReopenDrag,
    endReopenDrag,
    reopenDraggedRef
  } = useAiPanelLayout(onResize, onPausePtySync);

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
                          id,
                          {
                            paneSessions,
                            onMoveTab,
                            onFocusPane,
                            onReorderTab
                          }
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
          <EmptyTerminal
            onCreate={onCreate}
            onOpenLocal={onOpenLocal}
          />
        )}

        {/* SSH 欢迎卡片：钉在终端区顶部的浮层，手动关闭 */}
        {welcomeCard &&
          active?.kind === "ssh" &&
          active.id !== welcomeClosedFor && (
            <WelcomeCard
              session={active}
              onClose={() =>
                setWelcomeClosedFor(active.id)
              }
            />
          )}

        <BottomDrawer
          session={active}
          mode={bottomDrawer}
          onClose={() => setBottomDrawer("none")}
        />

        <TerminalStatus
          active={active}
          statusMode={statusMode}
          macros={macros}
          disconnected={disconnected}
          macroTargetId={macroTargetId}
          onRunMacro={onRunMacro}
          onAddMacro={onAddMacro}
          onEditMacro={onEditMacro}
          onDeleteMacro={onDeleteMacro}
          onReorderMacro={onReorderMacro}
          onNotify={onNotify}
          bottomDrawer={bottomDrawer}
          onOpenDrawer={setBottomDrawer}
        />

        {searchOpen && (
          <FindBox
            query={query}
            onQueryChange={setQuery}
            result={searchResult}
            error={searchError}
            caseSensitive={searchCaseSensitive}
            regex={searchRegex}
            onSearch={onSearch}
            onCloseSearch={onCloseSearch}
            onToggleCaseSensitive={
              onToggleCaseSensitive
            }
            onToggleRegex={onToggleRegex}
          />
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
        // 收起后的浮窗按钮：贴窗口右缘，点击向左拉回面板。
        // 也可上下拖动改垂直位置（reopenTop 为 null 时保持 CSS 居中）
        <button
          type="button"
          className="ai-reopen-tab"
          style={
            reopenTop === null
              ? undefined
              : ({
                  top: `${reopenTop}px`,
                  //给了具体 top 就得撤掉居中用的 bottom + margin:auto，
                  // 否则两者同时生效会被bottom 拉回视口底部
                  bottom: "auto",
                  margin: 0
                } as CSSProperties)
          }
          aria-label={t("ai.expand")}
          title={t("ai.expand")}
          onPointerDown={startReopenDrag}
          onPointerMove={moveReopenDrag}
          onPointerUp={endReopenDrag}
          onPointerCancel={endReopenDrag}
          onClick={() => {
            // 刚拖过的那一下不算点击（pointerup 已拦一道，
            // 这里再兜一层：拖拽后紧跟的 click 仍可能冒到这里）
            if (reopenDraggedRef.current) {
              reopenDraggedRef.current = false;
              return;
            }
            setAiCollapsed(false);
          }}
        >
          <LeftOutlined />
        </button>
      )}
    </div>
  );
}
