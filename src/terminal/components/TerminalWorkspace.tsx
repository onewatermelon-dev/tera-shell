import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { OpenSession } from "@/terminal/lib/useTerminals";
import {
  Button,
  Card,
  Dropdown,
  EmptyState,
  Input,
  Surface,
  Tabs,
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
  DownOutlined,
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
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 批量关闭多个会话（标签右键菜单：关闭右侧/其他/所有）。 */
  onCloseTabs: (ids: string[]) => void;
  onCreate: () => void;
  /** 打开本地终端：空状态里的次要操作。 */
  onOpenLocal: () => void;
  /** 点击标签后把键盘焦点交回对应终端（拆分标签同走这里）。 */
  onFocusTerminal: (id: string) => void;
  onSearch: (
    query: string,
    direction: "next" | "prev" | "input"
  ) => void;
  onCloseSearch: () => void;
  onToggleCaseSensitive: () => void;
  onToggleRegex: () => void;
  onTerminalHost: (
    el: HTMLElement | null
  ) => void;
  /** 拆分标签组：组内标签的会话 id 列表（按加入顺序）；空数组表示无拆分窗格。 */
  splitIds: string[];
  /** 当前显示在拆分窗格里的组内会话 id。 */
  splitVisibleId: string;
  /** 点组内标签：切换拆分窗格显示的会话。 */
  onActivateSplit: (id: string) => void;
  /** 拆分窗格宿主。 */
  onSplitHost: (el: HTMLElement | null) => void;
  /** 右键菜单「向右拆分」：用被右键会话的配置新起独立会话加进拆分标签组。
   *  返回新会话 id（失败为 undefined），调用方用它聚焦新标签。 */
  onSplit: (
    id?: string
  ) => Promise<string | undefined>;
  /** 拖标签换栏：在左栏标签条与拆分标签组之间搬移会话。 */
  onMoveTab: (
    id: string,
    to: "main" | "split"
  ) => void;
  /** 左栏内拖拽换位：把 id 插到 beforeId 之前，null 表示追加到末尾。 */
  onReorderTab: (
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
 * 标签名被截断时给滚动轨道挂 `.name-scroll`（动画见 _terminal.scss 的
 * name-loop：两份文字首尾相接、位移 -50%，无缝循环；悬停才播放）。
 * 量的是第一份文字的宽度（不含 margin）与名字盒的可视宽。
 * 纯 DOM 测量，放在模块作用域避免进依赖数组。
 */
function syncNameScroll() {
  document
    .querySelectorAll<HTMLElement>(
      ".tab-name-text:first-child"
    )
    .forEach(copy => {
      const track = copy.parentElement;
      const box = track?.parentElement;
      if (!track || !box) return;
      track.classList.toggle(
        "name-scroll",
        copy.offsetWidth > box.clientWidth + 1
      );
    });
}

export default function TerminalWorkspace({
  opened,
  active,
  disconnected,
  searchOpen,
  searchResult,
  searchError,
  searchCaseSensitive,
  searchRegex,
  onActivate,
  onFocusTerminal,
  onClose,
  onCloseTabs,
  onCreate,
  onOpenLocal,
  onSearch,
  onCloseSearch,
  onToggleCaseSensitive,
  onToggleRegex,
  onTerminalHost,
  splitIds,
  splitVisibleId,
  onActivateSplit,
  onSplitHost,
  onSplit,
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
  // 标签右键菜单：记录触发位置与目标标签，null 表示不显示
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    canCloseRight: boolean;
  } | null>(null);
  // 主栏宽度比例：分隔条拖动调整（限 20%~80%）；首次拆分重置为 0.5
  const [splitRatio, setSplitRatio] =
    useState(0.5);
  // 哪个窗格是当前活动栏：点标签/窗格时把选中胶囊挪到被点中的那一侧。
  // "main" = 左栏；"split" = 拆分窗格。左栏标签走 RAC 的 selectedKey，
  // 拆分标签不在 RAC Tabs 里，这侧得自己记。
  const [focusedPane, setFocusedPane] =
    useState<string>("main");
  const panesRef = useRef<HTMLDivElement>(null);
  const searchInputRef =
    useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState<
    OpenSession[]
  >([]);

  // 左栏标签列表：拆分会话只出现在右栏槽里，不进左栏（否则同一会话两个
  // 入口，点左栏那份会把元素拽去左栏宿主、和右栏宿主争夺）
  // 必须 useMemo：每次渲染都给新数组的话，computeOverflow 每次都重建、
  // 依赖它的 effect 每渲染都跑（渲染环），"把激活标签滚进可视区"的 effect
  // 也被带着每帧执行 —— 滚轮一往左滚就被它拉回最右的激活标签
  const sortedTabs = useMemo(
    () =>
      opened.filter(
        session => !splitIds.includes(session.id)
      ),
    [opened, splitIds]
  );
  // 拆分标签组的标签（按加入顺序）：一只独立会话（独立 PTY），共享下方
  // 一个窗格，点标签切换显示
  const splitSessions = splitIds
    .map(id =>
      opened.find(session => session.id === id)
    )
    .filter((session): session is OpenSession =>
      Boolean(session)
    );
  const splitCount = splitSessions.length;

  // 拆分窗格被整体关掉（组清空）时活动栏收回左栏，否则胶囊落在
  // 不存在的标签上。不写 useEffect 去 setState（set-state-in-effect
  // 会报错），改成派生：组空了 focusedPane 一律按左栏算。
  const activePane =
    focusedPane === "split" && splitCount > 0
      ? "split"
      : "main";
  // 快捷宏的目标会话：活动栏在左栏＝激活会话，在拆分窗格＝组内可见会话。
  // 与选中胶囊同源，宏执行落在用户正对着的那一栏。
  const macroTargetId =
    activePane === "main"
      ? active?.id
      : splitVisibleId;

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

  /** 左栏标签条真正滚动的元素：HeroUI Tabs.List 内部的 ScrollShadow
   *  （overflow-x: auto）。外层 .tabs 不溢出、scrollLeft 恒为 0，拿它算
   *  溢出只会看到右侧被藏起来的标签。按"内容宽 > 可视宽"从后代里找，
   *  找不到（标签没溢出）就退回 .tabs。 */
  const findTabScroller = useCallback(() => {
    const container = tabsRef.current;
    if (!container) return null;
    return (
      [
        ...container.querySelectorAll<HTMLElement>(
          "div"
        )
      ].find(
        el => el.scrollWidth > el.clientWidth + 1
      ) ?? container
    );
  }, []);

  const computeOverflow = useCallback(() => {
    const container = tabsRef.current;
    const scroller = findTabScroller();
    if (!container || !scroller) return;
    // 标签的 offsetParent 是内含的 list 容器，offsetLeft 就是内容坐标，
    // 与 scroller.scrollLeft 同一坐标系；±1 容掉亚像素舍入
    const start = scroller.scrollLeft;
    const end = start + scroller.clientWidth;
    const hidden: OpenSession[] = [];
    container
      .querySelectorAll<HTMLElement>(".tab")
      .forEach((el, index) => {
        const left = el.offsetLeft;
        const right = left + el.offsetWidth;
        const session = sortedTabs[index];
        // 拆分标签在 .tabs 之外的槽里，这里选不到，下标与 sortedTabs 天然对齐
        if (!session) return;
        if (left < start - 1 || right > end + 1)
          hidden.push(session);
      });
    setOverflowed(hidden);
    syncNameScroll();
  }, [sortedTabs, findTabScroller]);

  function activateOverflow(id: string) {
    const index = sortedTabs.findIndex(
      tab => tab.id === id
    );
    const tab =
      tabsRef.current?.querySelectorAll<HTMLElement>(
        ".tab"
      )[index];
    // 溢出菜单选的是左栏会话，焦点会回到左栏终端，胶囊同步收回左栏
    setFocusedPane("main");
    onActivate(id);
    tab?.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
    // 菜单关闭后 RAC 会把焦点还给触发器，等这一轮结束后再交给终端
    requestAnimationFrame(() =>
      onFocusTerminal(id)
    );
  }

  function onTabsWheel(event: React.WheelEvent) {
    const scroller = findTabScroller();
    if (!scroller) return;
    scroller.scrollLeft +=
      event.deltaY + event.deltaX;
  }

  // 拖标签换栏：RAC Tab 在 pointerdown 上 preventDefault，原生 HTML5
  // 拖拽起不来，只能手写 —— 按下记录候选，移动超阈值才进拖拽，松开时
  // 按落点换栏：左栏标签条 = 回左栏，拆分标签槽 = 去右栏，落点在别处 =
  // 取消。选中不在这里做：选中挂在按下那一下（调用方的 mousedown），
  // 挂到 click / 松手上会被手抖阈值和 preventDefault 吞掉。
  function startTabDrag(
    event: React.MouseEvent,
    id: string
  ) {
    // 只响应主键；× 关闭钮自己会 stopPropagation，不会进到这里
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    // 跟手浮标：纯 DOM 元素直接移动，不进 React 渲染（每次 pointermove
    // 都 setState 会让整棵工作区重渲染）
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
      // 没超阈值＝按下那一下已经完成选中，这里不换栏
      if (!dragging) return;
      // 拖拽结束抑制未尾的 click：避免落点上的元素被误点
      ev.preventDefault();
      // elementFromPoint 拿落点元素（标签被拖走后 pointer 命中的是
      // 别的元素，不能用 ev.target）
      const under = document.elementFromPoint(
        ev.clientX,
        ev.clientY
      );
      // .tabs-main 也收：落在 + 按钮/溢出按钮那一带的空白处同样算"回左栏"
      const hit = under?.closest(
        ".tabs-main, .tabs, .tabs-split"
      );
      if (hit?.classList.contains("tabs-split")) {
        // 拖进拆分标签组＝加一个标签（立刻可见），不新起窗格
        onMoveTab(id, "split");
        setFocusedPane("split");
      } else if (hit) {
        // 落在左栏：从右栏拖回来＝换栏；本来就在左栏＝换位
        if (splitIds.includes(id)) {
          onMoveTab(id, "main");
          setFocusedPane("main");
          return;
        }
        // 落点标签：指针过中线就插到它后面（取它右边那个标签当锚点，
        // 没有就是末尾）；落在空白处（最后一个标签右侧）＝追加到末尾
        const el = under?.closest(
          "[data-tab-id]"
        ) as HTMLElement | null;
        let beforeId: string | null = null;
        if (el) {
          const rect = el.getBoundingClientRect();
          const after =
            ev.clientX >
            rect.left + rect.width / 2;
          const anchor = el.getAttribute(
            "data-tab-id"
          );
          const index = sortedTabs.findIndex(
            item => item.id === anchor
          );
          beforeId = after
            ? (sortedTabs[index + 1]?.id ?? null)
            : anchor;
        }
        if (beforeId !== id)
          onReorderTab(id, beforeId);
      }
    };
    window.addEventListener(
      "pointermove",
      onMove
    );
    window.addEventListener("pointerup", onUp);
  }

  // 从会话栏点开新会话时，新标签可能落在分隔线之外被裁掉（看不到）。
  // 这里在激活会话变化后把它滚进可视区，保证"新开的标签自己会露出来"。
  useEffect(() => {
    if (!active?.id) return;
    const container = tabsRef.current;
    if (!container) return;
    const index = sortedTabs.findIndex(
      tab => tab.id === active.id
    );
    if (index < 0) return;
    container
      .querySelectorAll<HTMLElement>(".tab")
      [index]?.scrollIntoView({
        block: "nearest",
        inline: "nearest"
      });
  }, [active?.id, sortedTabs]);

  function toggleAndSearch(toggle: () => void) {
    toggle();
    onSearch(query, "input");
  }

  // 拖动拆分分隔条调整两栏宽度：pointermove 全局监听，比例限制 20%~80%；
  // 松开后容器尺寸变化由 ResizeObserver 感知，两栏终端会各自重新 fit
  function startPaneDrag(
    event: React.PointerEvent
  ) {
    event.preventDefault();
    const panes = panesRef.current;
    if (!panes) return;
    const onMove = (ev: PointerEvent) => {
      const rect = panes.getBoundingClientRect();
      // 比例按「总宽扣除 4px 分隔条」计算，与两栏 flex 权重
      // （basis 0%，剩余空间按权重分）保持一致
      const usable = Math.max(1, rect.width - 4);
      const ratio =
        (ev.clientX - rect.left) / usable;
      setSplitRatio(
        Math.min(0.8, Math.max(0.2, ratio))
      );
    };
    const onUp = () => {
      window.removeEventListener(
        "pointermove",
        onMove
      );
      window.removeEventListener(
        "pointerup",
        onUp
      );
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

  // 标签数变化时重算溢出
  useEffect(() => {
    requestAnimationFrame(computeOverflow);
  }, [opened.length, computeOverflow]);

  // 监听标签栏尺寸变化：溢出集合随可视宽度变化重算
  useEffect(() => {
    const container = tabsRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      computeOverflow();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [opened, computeOverflow]);

  // 监听真正的滚动容器：ScrollShadow 的 scroll 不冒泡，挂在 .tabs 上的
  // React onScroll 永远收不到，滚动到左边也不会重算溢出集合。
  // 依赖 opened.length —— 标签数变化后滚动容器可能换成 ScrollShadow
  useEffect(() => {
    const scroller = findTabScroller();
    if (!scroller) return;
    scroller.addEventListener(
      "scroll",
      computeOverflow,
      {
        passive: true
      }
    );
    return () =>
      scroller.removeEventListener(
        "scroll",
        computeOverflow
      );
  }, [
    computeOverflow,
    findTabScroller,
    opened.length
  ]);

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
        <div className="tabs-bar">
          {/* 左栏区域：标签条 + 新建/溢出按钮的定位锚点。flex 权重挂在这一层
            （拆分时＝主栏比例），+ 按钮因此钉在左栏末尾、分割线左侧，而不是
            卡片最右缘；权重与 .terminal-panes 主栏一致，标签槽与下方窗格
            严丝合缝 */}
          <div
            className="tabs-main"
            style={
              splitCount
                ? {
                    flex: `${splitRatio} 1 0%`
                  }
                : undefined
            }
          >
            <div
              ref={tabsRef}
              className="tabs"
              onWheel={onTabsWheel}
            >
              {/* HeroUI Tabs：selectedKey 驱动选中态；display:contents 让 Root
              不参与 .tabs 的 flex 布局。拆分栏标签不在这里（它是 .tabs-bar
              下的 .split-tab，见下）。胶囊外观由 .tab--on / .split-tab--on
              按 activePane 决定，两者互斥。 */}
              <Tabs
                className="contents"
                selectedKey={active?.id}
                onSelectionChange={key => {
                  if (key == null) return;
                  // 拆分标签不在这个 Tabs 里（见下方 .split-tab），这里只可能是会话
                  setFocusedPane("main");
                  onActivate(String(key));
                }}
              >
                <Tabs.List>
                  {sortedTabs.map(tab => (
                    <Tabs.Tab
                      key={tab.id}
                      id={tab.id}
                      /* data-tab-id：拖拽落点判定要找"鼠标下面是哪个标签"。
                     RAC Tab 类型不收原生 data-*，运行时透传，spread 绕开类型检查 */
                      {...{
                        "data-tab-id": tab.id
                      }}
                      onMouseDown={event =>
                        startTabDrag(
                          event,
                          tab.id
                        )
                      }
                      // .tab--on = 这只是一圈选中胶囊。只有"活动栏是左栏"且
                      // 命中当前会话时才加；两侧互斥，见 TerminalWorkspace 顶部
                      // activePane 与 _terminal.scss 的 .tab--on / .split-tab--on
                      className={
                        activePane === "main" &&
                        tab.id === active?.id
                          ? "tab tab--on"
                          : "tab"
                      }
                      onContextMenu={event => {
                        event.preventDefault();
                        const index =
                          sortedTabs.findIndex(
                            item =>
                              item.id === tab.id
                          );
                        setTabMenu({
                          x: event.clientX,
                          y: event.clientY,
                          tabId: tab.id,
                          canCloseRight:
                            index <
                            sortedTabs.length - 1
                        });
                      }}
                      // 点击已激活的标签不会触发 onSelectionChange（activeId 没变、
                      // 挂载用的 layout effect 也不会跑），这里统一在点击后交回焦点。
                      // RAC 在 press 阶段会聚焦 Tab 自身，故放到下一帧再抢，
                      // 保证最终的焦点落在终端上。关闭钮会 stopPropagation，点 × 不进这里。
                      onClick={() =>
                        requestAnimationFrame(
                          () =>
                            onFocusTerminal(
                              tab.id
                            )
                        )
                      }
                    >
                      <span
                        className={`status-dot${disconnected[tab.id] ? " off" : ""}`}
                      ></span>
                      {/* 名字截断后：悬停 + 滚轮横向滚动看全名（见 onTabsWheel），
                        不弹 tooltip */}
                      {/* 名字截断时悬停滚动：轨道里放两份文字首尾相接
                        （第二份 aria-hidden），位移 -50% 无缝循环 */}
                      <span className="tab-name">
                        <span className="tab-name-track">
                          <span className="tab-name-text">
                            {tab.name}
                          </span>
                          <span
                            className="tab-name-text"
                            aria-hidden="true"
                          >
                            {tab.name}
                          </span>
                        </span>
                      </span>
                      {/* 关闭钮在 RAC Tab 内部：pointerdown 也要拦截，
                      否则外层 Tab 的 press 会先于 click 触发 */}
                      <i
                        onPointerDown={e =>
                          e.stopPropagation()
                        }
                        onClick={e => {
                          e.stopPropagation();
                          onClose(tab.id);
                        }}
                      >
                        ×
                      </i>
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs>
            </div>
            {/* 新建标签按钮钉在左栏区域末尾（外面包着 .tabs-main，absolute
            锚点是它）：拆分时不会被一起裁掉，也不会跑到分割线右边 */}
            <Hint label={t("terminal.newTab")}>
              <Button
                className="new-tab"
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={t("terminal.newTab")}
                onPress={onCreate}
              >
                <PlusOutlined />
              </Button>
            </Hint>
            {tabMenu && (
              <TabContextMenu
                x={tabMenu.x}
                y={tabMenu.y}
                canCloseRight={
                  tabMenu.canCloseRight
                }
                // 已有拆分栏的会话不再显示拆分项（菜单也从拆分标签上触发）
                canSplit={
                  !splitIds.includes(
                    tabMenu.tabId
                  )
                }
                onClose={() => setTabMenu(null)}
                onAction={(action: TabAction) => {
                  if (action === "split") {
                    // 拆的是被右键的那个标签（VSCode 行为），新会话加进拆分标签组。
                    // 首次拆分时把分割线归到正中；组已在就不动用户拖过的比例
                    if (splitCount === 0)
                      setSplitRatio(0.5);
                    void onSplit(
                      tabMenu.tabId
                    ).then(newId => {
                      if (!newId) return;
                      setFocusedPane("split");
                      requestAnimationFrame(() =>
                        onFocusTerminal(newId)
                      );
                    });
                    return;
                  }
                  // 关闭右侧/其他只作用于左栏列表；关闭所有连拆分栏一起关
                  const ids = sortedTabs.map(
                    item => item.id
                  );
                  const index = ids.indexOf(
                    tabMenu.tabId
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
                    onCloseTabs(
                      opened.map(item => item.id)
                    );
                  }
                }}
              />
            )}
            {overflowed.length > 0 && (
              <div className="tabs-more">
                {/* 溢出标签菜单：原先是手写 fixed 定位 + 全局 mousedown 收起，
                现统一交给 HeroUI Dropdown（自动定位、焦点管理与关闭语义） */}
                <Dropdown.Root>
                  {/* 触发器必须是 MenuTrigger 的直接子元素：外面包 Tooltip 的话
                  RAC 找不到 pressable child，菜单打不开并报 PressResponder 警告。
                  提示信息改用 aria-label 承载。 */}
                  <Dropdown.Trigger
                    className="more-btn"
                    aria-label={t(
                      "terminal.overflowTabs",
                      {
                        count: overflowed.length
                      }
                    )}
                  >
                    <DownOutlined />
                  </Dropdown.Trigger>
                  <Dropdown.Popover placement="bottom end">
                    <Dropdown.Menu
                      aria-label={t(
                        "terminal.moreTabs"
                      )}
                      selectionMode="single"
                      selectedKeys={
                        active ? [active.id] : []
                      }
                      onAction={key =>
                        activateOverflow(
                          String(key)
                        )
                      }
                    >
                      {overflowed.map(tab => (
                        <Dropdown.Item
                          key={tab.id}
                          id={tab.id}
                          textValue={tab.name}
                        >
                          <span
                            className={`status-dot${disconnected[tab.id] ? " off" : ""}`}
                          ></span>
                          <span className="more-item-name">
                            {tab.name}
                          </span>
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.Root>
              </div>
            )}
          </div>
          {/* 拆分标签条：右侧窗格是第二个标签组，标签按内容收宽横向排列。
            整条与下方拆分窗格用同一套 flex 权重（主栏 ratio、1-ratio、
            占位对齐 4px 分隔条），天然钉在分割线右侧并跟随拖动。
            必须放在 .tabs-main 之外的 .tabs-bar 下，条才和窗格同参照系 */}
          {splitCount > 0 && (
            <>
              <div className="tabs-divider-gap" />
              <div
                className="tabs-split"
                style={{
                  flex: `${1 - splitRatio} 1 0%`
                }}
                onWheel={event => {
                  event.currentTarget.scrollLeft +=
                    event.deltaY + event.deltaX;
                }}
              >
                {splitSessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    // 按下即切到这只标签（不依赖 click：拖拽会抑制 click，
                    // 手抖超过阈值也会让"松手才算"的判定失效）；
                    // 接着交给 startTabDrag，拖到别处就是换栏
                    onMouseDown={event => {
                      if (event.button !== 0)
                        return;
                      // 点标签只切换拆分窗格里显示的会话，不抢活动栏/键盘焦点 ——
                      // 聚焦当前在主窗格时点了标签不该把输入口也挪过去；
                      // 要激活拆分窗格：点窗格内部（宿主 div 的 mousedown）。
                      // 拆分窗格已是活动栏时，焦点跟着新会话走（接着敲的场景）
                      onActivateSplit(session.id);
                      if (activePane === "split")
                        requestAnimationFrame(
                          () =>
                            onFocusTerminal(
                              session.id
                            )
                        );
                      startTabDrag(
                        event,
                        session.id
                      );
                    }}
                    // .split-tab--on = 拆分窗格当前显示的那只的选中胶囊，
                    // 仅在活动栏是拆分窗格时加上；与左栏 .tab--on 互斥
                    className={
                      activePane === "split" &&
                      session.id ===
                        splitVisibleId
                        ? "split-tab split-tab--on"
                        : "split-tab"
                    }
                    onContextMenu={event => {
                      event.preventDefault();
                      setTabMenu({
                        x: event.clientX,
                        y: event.clientY,
                        tabId: session.id,
                        canCloseRight: false
                      });
                    }}
                  >
                    <span
                      className={`status-dot${disconnected[session.id] ? " off" : ""}`}
                    ></span>
                    {/* 名字截断后：悬停 + 滚轮横向滚动看全名（与左栏一致） */}
                    <span className="split-tab-name">
                      <span className="tab-name-track">
                        <span className="tab-name-text">
                          {session.name}
                        </span>
                        <span
                          className="tab-name-text"
                          aria-hidden="true"
                        >
                          {session.name}
                        </span>
                      </span>
                    </span>
                    {/* × = 关掉这个标签的会话（独立 PTY 一并结束） */}
                    <i
                      // pointerdown 与 mousedown 都要拦：前者是 RAC 的
                      // press，后者会触发标签的拖拽/轻点判定
                      onPointerDown={e =>
                        e.stopPropagation()
                      }
                      onMouseDown={e =>
                        e.stopPropagation()
                      }
                      onClick={e => {
                        e.stopPropagation();
                        onClose(session.id);
                      }}
                    >
                      ×
                    </i>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {opened.length > 0 ? (
          splitCount > 0 ? (
            // 拆分状态：主栏 + 拆分窗格并排（组内切标签只换窗格里的内容）；
            // key 与空状态分支不同（理由见下）。拖动分隔条调整两栏比例（20%~80%）。
            <div
              key="split"
              ref={panesRef}
              className="terminal-panes"
            >
              <div
                ref={onTerminalHost}
                className="terminal-host"
                // 点进左栏终端就把活动栏收回左栏，胶囊跟着回到对应会话标签
                onMouseDown={() => {
                  setFocusedPane("main");
                  if (active)
                    onFocusTerminal(active.id);
                }}
                style={{
                  // grow 权重分配「剩余空间」（已扣除 4px 分隔条）：
                  // 50% 时分割线恰在正中；若用固定 basis，
                  // 两栏加分隔条会超出容器，分隔线产生偏移
                  flex: `${splitRatio} 1 0%`
                }}
              ></div>
              <div
                className="pane-divider"
                onPointerDown={startPaneDrag}
              ></div>
              <div
                ref={onSplitHost}
                className="terminal-host terminal-host--split"
                // 点进拆分窗格就把活动栏切过去
                onMouseDown={() => {
                  setFocusedPane("split");
                  onFocusTerminal(splitVisibleId);
                }}
                style={{
                  flex: `${1 - splitRatio} 1 0%`
                }}
              ></div>
            </div>
          ) : (
            // key 必须与空状态分支不同：终端元素是 replaceChildren 命令式挂进宿主的，
            // React 不感知；若两个分支复用同一 div 节点，关闭全部标签后残留的
            // .terminal-instance 会挤进 .empty-terminal 首位，把内容顶离垂直居中。
            <div
              key="host"
              ref={onTerminalHost}
              className="terminal-host"
              onMouseDown={() => {
                if (active)
                  onFocusTerminal(active.id);
              }}
            ></div>
          )
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
