import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type { OpenSession } from "@/hooks/useTerminals";
import {
  Button,
  EmptyState,
  Input,
  Typography
} from "@heroui/react";
import Hint from "@/components/Hint";
import {
  PlusOutlined,
  DownOutlined,
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
  onClose,
  onCreate,
  onSearch,
  onCloseSearch,
  onToggleCaseSensitive,
  onToggleRegex,
  onTerminalHost
}: Props) {
  const [query, setQuery] = useState("");
  const searchInputRef =
    useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const moreButtonRef =
    useRef<HTMLButtonElement>(null);
  const [dropdownOpen, setDropdownOpen] =
    useState(false);
  const [overflowed, setOverflowed] = useState<
    OpenSession[]
  >([]);
  const [moreListPos, setMoreListPos] = useState({
    top: 0,
    right: 0
  });

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
    if (!hidden.length) setDropdownOpen(false);
  }, [opened]);

  function positionMoreList() {
    if (!moreButtonRef.current) return;
    const rect =
      moreButtonRef.current.getBoundingClientRect();
    setMoreListPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right
    });
  }

  function toggleDropdown() {
    setDropdownOpen(prev => {
      const next = !prev;
      if (next) positionMoreList();
      return next;
    });
  }

  function activateOverflow(id: string) {
    const index = opened.findIndex(
      tab => tab.id === id
    );
    const tab =
      tabsRef.current?.querySelectorAll<HTMLElement>(
        ".tab"
      )[index];
    setDropdownOpen(false);
    onActivate(id);
    tab?.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
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

  // 监听标签栏尺寸变化
  useEffect(() => {
    const container = tabsRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      computeOverflow();
      if (dropdownOpen) positionMoreList();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [dropdownOpen, opened, computeOverflow]);

  // 点击标签栏外部时收起下拉
  useEffect(() => {
    const onMousedown = (event: MouseEvent) => {
      const target = event.target as Node;
      const more =
        moreButtonRef.current?.parentElement;
      if (
        !tabsRef.current?.contains(target) &&
        !more?.contains(target)
      )
        setDropdownOpen(false);
    };
    document.addEventListener(
      "mousedown",
      onMousedown
    );
    return () =>
      document.removeEventListener(
        "mousedown",
        onMousedown
      );
  }, []);

  const searchCount = searchResult.count;
  const searchIndex = searchResult.index;

  return (
    <section className="terminal-pane">
      <div className="tabs-bar">
        <div
          ref={tabsRef}
          className="tabs"
          onScroll={computeOverflow}
          onWheel={onTabsWheel}
        >
          {opened.map(tab => (
            <Button
              key={tab.id}
              className={`tab${active?.id === tab.id ? " active" : ""}`}
              variant="tertiary"
              onPress={() => onActivate(tab.id)}
            >
              <span
                className={`status-dot${disconnected[tab.id] ? " off" : ""}`}
              ></span>
              <span>{tab.name}</span>
              {/* 关闭钮在 RAC Button 内部：pointerdown 也要拦截，
                  否则外层 Button 的 press 会先于 click 触发 */}
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
            </Button>
          ))}
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
            <Hint
              label={`${overflowed.length} 个标签超出显示`}
            >
              <Button
                ref={moreButtonRef}
                className={`more-btn${dropdownOpen ? " open" : ""}`}
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="更多标签"
                onPress={toggleDropdown}
              >
                <DownOutlined />
              </Button>
            </Hint>
            {dropdownOpen && (
              <div
                className="more-list"
                style={{
                  top: `${moreListPos.top}px`,
                  right: `${moreListPos.right}px`
                }}
              >
                {overflowed.map(tab => (
                  <Button
                    key={tab.id}
                    className={`more-item${active?.id === tab.id ? " active" : ""}`}
                    variant="ghost"
                    size="sm"
                    onPress={() =>
                      activateOverflow(tab.id)
                    }
                  >
                    <span
                      className={`status-dot${disconnected[tab.id] ? " off" : ""}`}
                    ></span>
                    <span>{tab.name}</span>
                  </Button>
                ))}
              </div>
            )}
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
          <LinkOutlined />
          <Typography.Heading level={2}>
            选择一个会话开始连接
          </Typography.Heading>
          <Typography.Paragraph size="sm">
            从左侧打开本地终端，或新建一个 SSH
            会话。
          </Typography.Paragraph>
          <Button
            variant="primary"
            size="sm"
            onPress={onCreate}
          >
            <PlusOutlined />
            新建会话
          </Button>
        </EmptyState>
      )}

      <div className="terminal-status">
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

      {searchOpen && (
        <div className="find-box">
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
            <Button
              className={`find-btn${searchCaseSensitive ? " on" : ""}`}
              variant="tertiary"
              size="sm"
              aria-label="区分大小写"
              onPress={() =>
                toggleAndSearch(
                  onToggleCaseSensitive
                )
              }
            >
              Aa
            </Button>
          </Hint>
          <Hint label="正则表达式">
            <Button
              className={`find-btn${searchRegex ? " on" : ""}`}
              variant="tertiary"
              size="sm"
              aria-label="正则表达式"
              onPress={() =>
                toggleAndSearch(onToggleRegex)
              }
            >
              .*
            </Button>
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
        </div>
      )}
    </section>
  );
}
