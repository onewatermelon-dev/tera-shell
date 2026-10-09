import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { Button, Dropdown } from "@heroui/react";
import {
  PlusOutlined,
  DownOutlined
} from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import { useT } from "@/settings/lib/i18n";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

type Props = {
  /** 窗格 id：拖标签时作为落点标识 */
  paneId: string;
  /** 本窗格的标签（独立会话，按加入顺序） */
  sessions: OpenSession[];
  /** 本窗格当前显示哪一只 */
  visibleId: string;
  /** 本窗格是否是活动窗格（决定选中胶囊） */
  active: boolean;
  /** 断线状态：给标签点一个灰点 */
  disconnected: Record<string, boolean>;
  /** 本窗格是否显示「新建」按钮（只有首个窗格显示，避免一排重复入口） */
  showCreate: boolean;
  onCreate: () => void;
  /** 点标签：切本窗格显示的会话 */
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** 标签右键菜单 */
  onContextMenu: (
    event: ReactMouseEvent,
    session: OpenSession,
    index: number
  ) => void;
  /** 标签按下：起手拖拽（跨窗格搬移 / 窗格内换位） */
  onTabPointerDown: (
    event: ReactMouseEvent,
    id: string
  ) => void;
};

/** 悬停/聚焦标签名被截断时滚动看全名。 */
function syncNameScroll() {
  document
    .querySelectorAll<HTMLElement>(
      ".pane-tab-name-text:first-child"
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

/**
 * 单个窗格的标签条。
 *
 * 所有窗格都用这一套（不再区分「主栏 / 拆分栏」）：网格里每个格子都
 * 是平等的一格，标签条只是它自己的表头。用普通 button 而不是 HeroUI
 * Tabs —— RAC 的 Tabs 需要一份 selectedKey 状态，N 个窗格各挂一个
 * Root 会让选中态分散在多处；而且标签要能自由拖到别的窗格去，
 * 按钮更直接。
 */
export default function PaneTabBar({
  paneId,
  sessions,
  visibleId,
  active,
  disconnected,
  showCreate,
  onCreate,
  onSelect,
  onClose,
  onContextMenu,
  onTabPointerDown
}: Props) {
  const t = useT();
  const scrollerRef =
    useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState<
    OpenSession[]
  >([]);

  /** 真正滚动的是 .pane-tabs 自身（overflow-x: auto）。 */
  const computeOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const start = scroller.scrollLeft;
    const end = start + scroller.clientWidth;
    const hidden: OpenSession[] = [];
    scroller
      .querySelectorAll<HTMLElement>(".pane-tab")
      .forEach((el, index) => {
        const session = sessions[index];
        if (!session) return;
        // offsetLeft 与 scrollLeft 同一坐标系；±1 容掉亚像素舍入
        if (
          el.offsetLeft < start - 1 ||
          el.offsetLeft + el.offsetWidth > end + 1
        )
          hidden.push(session);
      });
    setOverflowed(hidden);
    syncNameScroll();
  }, [sessions]);

  // 标签数或窗格宽度变化都影响溢出；ResizeObserver 覆盖拖分隔条、
  // 窗口缩放、AI 面板开合等一切改宽度的场景
  useEffect(() => {
    requestAnimationFrame(computeOverflow);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const ro = new ResizeObserver(
      computeOverflow
    );
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [computeOverflow]);

  function activateOverflow(id: string) {
    onSelect(id);
    scrollerRef.current
      ?.querySelector<HTMLElement>(
        `[data-pane-tab-id="${id}"]`
      )
      ?.scrollIntoView({
        block: "nearest",
        inline: "nearest"
      });
  }

  function onWheel(event: React.WheelEvent) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollLeft +=
      event.deltaY + event.deltaX;
  }

  return (
    <div
      className="pane-tabs"
      data-pane-tabs={paneId}
      ref={scrollerRef}
      onWheel={onWheel}
    >
      {sessions.map((session, index) => (
        <button
          key={session.id}
          type="button"
          /* data-pane-tab-id：拖拽落点判定要按标签取窗格与锚点 */
          {...{ "data-pane-tab-id": session.id }}
          // 按下即切到这只标签（不依赖 click：拖拽会抑制 click，
          // 手抖超过阈值也会让"松手才算"的判定失效）
          onMouseDown={event => {
            if (event.button !== 0) return;
            onSelect(session.id);
            onTabPointerDown(event, session.id);
          }}
          onContextMenu={event => {
            event.preventDefault();
            onContextMenu(event, session, index);
          }}
          className={
            active && session.id === visibleId
              ? "pane-tab pane-tab--on"
              : "pane-tab"
          }
        >
          <span
            className={`status-dot${disconnected[session.id] ? " off" : ""}`}
          ></span>
          {/* 名字截断后：悬停横向滚动看全名（轨道里两份文字首尾相接） */}
          <span className="pane-tab-name">
            <span className="pane-tab-name-track">
              <span className="pane-tab-name-text">
                {session.name}
              </span>
              <span
                className="pane-tab-name-text"
                aria-hidden="true"
              >
                {session.name}
              </span>
            </span>
          </span>
          {/* × = 关掉这个标签的会话（独立 PTY 一并结束） */}
          <i
            // pointerdown 与 mousedown 都要拦：前者会被外层 Tab 的
            // press 捕获，后者会触发拖拽/轻点判定
            onPointerDown={e =>
              e.stopPropagation()
            }
            onMouseDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              onClose(session.id);
            }}
          >
            ×
          </i>
        </button>
      ))}
      {showCreate && (
        <Hint label={t("terminal.newTab")}>
          <Button
            className="pane-tab-new"
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={t("terminal.newTab")}
            onPress={onCreate}
          >
            <PlusOutlined />
          </Button>
        </Hint>
      )}
      {overflowed.length > 0 && (
        <div className="pane-tabs-more">
          {/* 溢出标签菜单：HeroUI Dropdown 负责定位、焦点管理与关闭语义 */}
          <Dropdown.Root>
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
                  sessions.some(
                    s => s.id === visibleId
                  )
                    ? [visibleId]
                    : []
                }
                onAction={key =>
                  activateOverflow(String(key))
                }
              >
                {overflowed.map(session => (
                  <Dropdown.Item
                    key={session.id}
                    id={session.id}
                    textValue={session.name}
                  >
                    {session.name}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        </div>
      )}
    </div>
  );
}
