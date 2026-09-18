import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type { OpenSession } from "@/features/terminal/useTerminals";
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
import MacroBar from "@/features/terminal/MacroBar";
import type { TerminalMacro } from "@/features/terminal/terminalMacros";
import {
  PlusOutlined,
  DownOutlined,
  DesktopOutlined,
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
  onCreate: () => void;
  /** 打开本地终端：空状态里的次要操作。 */
  onOpenLocal: () => void;
  /** 点击标签后把键盘焦点交回对应终端。 */
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
  /** 快捷宏列表。 */
  macros: TerminalMacro[];
  /** 点击某个宏：在活动会话里执行它的命令。 */
  onRunMacro: (macro: TerminalMacro) => void;
  /** 点击 + ：弹出新增快捷宏的窗口。 */
  onAddMacro: () => void;
  /** 右键某个宏 → 编辑。 */
  onEditMacro: (macro: TerminalMacro) => void;
  /** 右键某个宏 → 删除。 */
  onDeleteMacro: (macro: TerminalMacro) => void;
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
  onActivate,
  onFocusTerminal,
  onClose,
  onCreate,
  onOpenLocal,
  onSearch,
  onCloseSearch,
  onToggleCaseSensitive,
  onToggleRegex,
  onTerminalHost,
  macros,
  onRunMacro,
  onAddMacro,
  onEditMacro,
  onDeleteMacro
}: Props) {
  const [query, setQuery] = useState("");
  const searchInputRef =
    useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState<
    OpenSession[]
  >([]);

  const computeOverflow = useCallback(() => {
    const container = tabsRef.current;
    if (!container) return;
    const start = container.scrollLeft;
    const end = start + container.clientWidth;
    const hidden: OpenSession[] = [];
    container
      .querySelectorAll<HTMLElement>(".tab")
      .forEach((el, index) => {
        const left = el.offsetLeft;
        const right = left + el.offsetWidth;
        const session = opened[index];
        if (
          session &&
          (left < start || right > end)
        )
          hidden.push(session);
      });
    setOverflowed(hidden);
  }, [opened]);

  function activateOverflow(id: string) {
    const index = opened.findIndex(
      tab => tab.id === id
    );
    const tab =
      tabsRef.current?.querySelectorAll<HTMLElement>(
        ".tab"
      )[index];
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
    const container = tabsRef.current;
    if (!container) return;
    container.scrollLeft +=
      event.deltaY + event.deltaX;
  }

  function toggleAndSearch(toggle: () => void) {
    toggle();
    onSearch(query, "input");
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

  const searchCount = searchResult.count;
  const searchIndex = searchResult.index;

  return (
    // HeroUI Card 面板：圆角 + surface 底色，p-0/gap-0 抵消 Card 内边距
    <Card className="terminal-pane rounded-xl p-0 gap-0">
      <div className="tabs-bar">
        <div
          ref={tabsRef}
          className="tabs"
          onScroll={computeOverflow}
          onWheel={onTabsWheel}
        >
          {/* HeroUI Tabs：selectedKey 驱动激活态 + segment 滑动指示条；
              display:contents 让 Root 不参与 .tabs 的 flex 布局 */}
          <Tabs
            className="contents"
            selectedKey={active?.id}
            onSelectionChange={key => {
              if (key != null)
                onActivate(String(key));
            }}
          >
            <Tabs.List>
              {opened.map(tab => (
                <Tabs.Tab
                  key={tab.id}
                  id={tab.id}
                  className="tab"
                  // 点击已激活的标签不会触发 onSelectionChange（activeId 没变、
                  // 挂载用的 layout effect 也不会跑），这里统一在点击后交回焦点。
                  // RAC 在 press 阶段会聚焦 Tab 自身，故放到下一帧再抢，
                  // 保证最终的焦点落在终端上。关闭钮会 stopPropagation，点 × 不进这里。
                  onClick={() =>
                    requestAnimationFrame(() =>
                      onFocusTerminal(tab.id)
                    )
                  }
                >
                  <span
                    className={`status-dot${disconnected[tab.id] ? " off" : ""}`}
                  ></span>
                  <span>{tab.name}</span>
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
          <Hint label="新建会话">
            <Button
              className="new-tab"
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label="新建会话"
              onPress={onCreate}
            >
              <PlusOutlined />
            </Button>
          </Hint>
        </div>
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
                aria-label={`${overflowed.length} 个标签超出显示`}
              >
                <DownOutlined />
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  aria-label="更多标签"
                  selectionMode="single"
                  selectedKeys={
                    active ? [active.id] : []
                  }
                  onAction={key =>
                    activateOverflow(String(key))
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

      {opened.length > 0 ? (
        // key 必须与空状态分支不同：终端元素是 replaceChildren 命令式挂进宿主的，
        // React 不感知；若两个分支复用同一 div 节点，关闭全部标签后残留的
        // .terminal-instance 会挤进 .empty-terminal 首位，把内容顶离垂直居中。
        <div
          key="host"
          ref={onTerminalHost}
          className="terminal-host"
        ></div>
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
            选择一个会话开始连接
          </Typography.Heading>
          <Typography.Paragraph
            size="sm"
            className="empty-desc"
          >
            从左侧打开本地终端，或新建一个 SSH
            会话。
          </Typography.Paragraph>
          <div className="empty-actions">
            <Button
              variant="primary"
              size="sm"
              onPress={onCreate}
            >
              <PlusOutlined />
              新建会话
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={onOpenLocal}
            >
              <DesktopOutlined />
              打开本地终端
            </Button>
          </div>
        </EmptyState>
      )}

      <div className="terminal-status">
        {/* 快捷宏挤在状态栏最前面：常驻可见，又不单独占一行 */}
        <MacroBar
          macros={macros}
          disabled={
            !active ||
            disconnected[active.id] === true
          }
          onRun={onRunMacro}
          onAdd={onAddMacro}
          onEdit={onEditMacro}
          onDelete={onDeleteMacro}
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
      </div>

      {searchOpen && (
        // HeroUI Surface：查找浮层的底色/描边/阴影跟随主题 token
        <Surface className="find-box">
          <Input
            ref={searchInputRef}
            className="find-input"
            placeholder="查找"
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
                  ? "无匹配"
                  : "")}
          </span>
          <Hint label="上一个 (Shift+Enter)">
            <Button
              className="find-btn"
              variant="tertiary"
              size="sm"
              aria-label="上一个"
              onPress={() =>
                onSearch(query, "prev")
              }
            >
              ↑
            </Button>
          </Hint>
          <Hint label="下一个 (Enter)">
            <Button
              className="find-btn"
              variant="tertiary"
              size="sm"
              aria-label="下一个"
              onPress={() =>
                onSearch(query, "next")
              }
            >
              ↓
            </Button>
          </Hint>
          <Hint label="区分大小写">
            <ToggleButton
              className="find-btn"
              variant="ghost"
              size="sm"
              aria-label="区分大小写"
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
          <Hint label="正则表达式">
            <ToggleButton
              className="find-btn"
              variant="ghost"
              size="sm"
              aria-label="正则表达式"
              isSelected={searchRegex}
              onChange={() =>
                toggleAndSearch(onToggleRegex)
              }
            >
              .*
            </ToggleButton>
          </Hint>
          <Hint label="关闭 (Esc)">
            <Button
              className="find-btn"
              variant="tertiary"
              size="sm"
              aria-label="关闭查找"
              onPress={onCloseSearch}
            >
              ×
            </Button>
          </Hint>
        </Surface>
      )}
    </Card>
  );
}
