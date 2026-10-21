/**
 * 命令历史检索面板（Ctrl+R 风格）。
 *
 * 交互照抄 shell 的 reverse-i-search：输入即过滤、↑↓ 选、Enter 把命令
 * **插进输入行但不执行**、Esc 关掉。额外多两件事：
 *
 * - **范围切换**：默认只看当前主机（这就是「按主机隔离」的意义），
 *   Tab 或点按钮切到「全部主机」做跨机检索 —— 远端 shell 的历史天然按
 *   机器割裂，能一次搜遍所有机器是桌面端独有的能力；
 * - **退出码**：失败的命令标出来（非 0 显示 `=N`），不必再靠记忆分辨
 *   哪次 `docker compose up` 是跑挂的那次。
 *
 * 数据是**打开那一刻的快照**：面板开着时用户敲不了终端，历史不会变，
 * 每次输入都重新读盘纯属浪费。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Input, Surface } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import {
  historySnapshot,
  hostLabelOf,
  searchEntries,
  type CommandHistoryEntry
} from "@/terminal/lib/commandHistory";

/** 一次最多渲染多少条：5000 条全塞进 DOM 会明显卡。 */
const VISIBLE_LIMIT = 200;

/**
 * 时间的紧凑写法：今天只显示时分，更早显示月-日。
 *
 * @param at 毫秒时间戳；0 表示历史遗留（没有时间），返回空串
 */
function formatWhen(at: number): string {
  if (!at) return "";
  const date = new Date(at);
  const pad = (value: number) =>
    String(value).padStart(2, "0");
  if (
    date.toDateString() ===
    new Date().toDateString()
  ) {
    return `${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }
  return `${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}

export function HistoryPanel({
  host,
  onInsert,
  onClose
}: {
  /** 当前会话的主机标识（默认过滤范围） */
  host: string;
  onInsert: (command: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<
    "host" | "all"
  >("host");
  const [index, setIndex] = useState(0);
  // 面板是条件渲染的（每次打开都重新挂载），useState 的惰性初值就是
  // 「打开那一刻」的快照 —— 不需要再在 effect 里读一次
  const [entries] = useState<
    CommandHistoryEntry[]
  >(() => historySnapshot());
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * 打开后把焦点交给输入框。
   *
   * ⚠️ 不能只 `inputRef.current?.focus()`：HeroUI 的 Input 外面包了一层
   * 结构，ref 拿到的未必是原生 input，而且首帧时内部 input 可能还没挂上。
   * 直接从面板容器里找 `input` 更稳，并分三拍尝试（挂载即试、下一帧、
   * 80ms 后）—— 焦点在终端里的话，↑↓ 会被终端的历史翻页吃掉、Enter 会
   * 直接执行命令，面板看着「按键全都不生效」。
   */
  useLayoutEffect(() => {
    const focusInput = () => {
      const input =
        panelRef.current?.querySelector<HTMLInputElement>(
          "input"
        );
      if (input) {
        input.focus();
        return;
      }
      // 找不到输入框时把焦点压在遮罩上：此时字母键不再落进终端，
      // 至少不会误执行命令（键盘导航由 window 监听兜着）
      panelRef.current?.focus();
    };
    focusInput();
    const raf = requestAnimationFrame(focusInput);
    const timer = setTimeout(focusInput, 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  const results = useMemo(
    () =>
      searchEntries(
        entries,
        query,
        scope === "host" ? host : undefined
      ).slice(0, VISIBLE_LIMIT),
    [entries, query, scope, host]
  );

  // 换关键词/范围后回到第一条：跟输入一起改，别放进 effect
  // （effect 里同步 setState 会多一轮渲染，lint 也不让）

  // 键盘上下移动时把选中项滚进可视区
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-index="${index}"]`
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [index, results]);

  const pick = (item?: CommandHistoryEntry) => {
    const target = item ?? results[index];
    if (target) onInsert(target.cmd);
  };

  /**
   * 键盘绑在**捕获阶段的 window** 上，不是输入框的 onKeyDown。
   *
   * 原因：焦点一旦没落在输入框（打开瞬间终端还拿着焦点、或者用户点了
   * 一下列表），按键就全被终端吃掉 —— ↑↓ 变成翻 shell 历史、Enter 直接
   * 执行命令，面板看起来「按键全都不生效」。放进捕获阶段能先于 xterm 与
   * AppHeader 拿到事件，无论焦点在哪都管用。
   *
   * 只拦这五个键，其它（包括 Ctrl+C/V）原样放行。
   */
  useEffect(() => {
    /**
     * 吃掉这个按键：`preventDefault` 拦浏览器默认行为（Tab 移焦点、
     * 光标移动），`stopPropagation` 拦后续监听 —— xterm 的 keydown
     * 不检查 `defaultPrevented`，只 preventDefault 的话焦点还在终端时
     * ↑ 会既移动选中项、又翻一遍 shell 历史。
     */
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        consume(event);
        onClose();
        return;
      }
      // Tab 切范围（不能让它把焦点移走，焦点要留在输入框继续敲）
      if (event.key === "Tab") {
        consume(event);
        setScope(current =>
          current === "host" ? "all" : "host"
        );
        setIndex(0);
        return;
      }
      if (event.key === "ArrowDown") {
        consume(event);
        setIndex(current =>
          Math.min(
            current + 1,
            results.length - 1
          )
        );
        return;
      }
      if (event.key === "ArrowUp") {
        consume(event);
        setIndex(current =>
          Math.max(current - 1, 0)
        );
        return;
      }
      if (event.key === "Enter") {
        consume(event);
        const target = results[index];
        if (target) onInsert(target.cmd);
      }
    };
    window.addEventListener(
      "keydown",
      onKeyDown,
      true
    );
    return () =>
      window.removeEventListener(
        "keydown",
        onKeyDown,
        true
      );
  }, [results, index, onClose, onInsert]);

  return (
    <div
      className="history-overlay"
      ref={panelRef}
      tabIndex={-1}
      onMouseDown={event => {
        // 点遮罩关闭；点面板内部不关
        if (event.target === event.currentTarget)
          onClose();
      }}
    >
      <Surface className="history-panel">
        <div className="history-head">
          <Input
            className="history-input"
            placeholder={t(
              "terminal.history.placeholder"
            )}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setIndex(0);
            }}
          />
          <div className="history-scope">
            <button
              type="button"
              data-active={scope === "host"}
              onClick={() => {
                setScope("host");
                setIndex(0);
              }}
            >
              {t("terminal.history.scopeHost")}
            </button>
            <button
              type="button"
              data-active={scope === "all"}
              onClick={() => {
                setScope("all");
                setIndex(0);
              }}
            >
              {t("terminal.history.scopeAll")}
            </button>
          </div>
        </div>
        <div
          className="history-list"
          ref={listRef}
        >
          {results.length === 0 ? (
            <div className="history-empty">
              {t("terminal.history.empty")}
            </div>
          ) : (
            results.map((item, row) => (
              <button
                key={`${item.host}|${item.cmd}|${item.at}|${row}`}
                type="button"
                data-index={row}
                data-active={row === index}
                className="history-row"
                onMouseEnter={() => setIndex(row)}
                onClick={() => pick(item)}
              >
                <span className="history-cmd">
                  {item.cmd}
                </span>
                <span className="history-host">
                  {hostLabelOf(item.host)}
                </span>
                {item.exitCode !== null &&
                  item.exitCode !== 0 && (
                    <span className="history-exit">
                      ={item.exitCode}
                    </span>
                  )}
                <span className="history-time">
                  {formatWhen(item.at)}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="history-foot">
          {t("terminal.history.hint")}
        </div>
      </Surface>
    </div>
  );
}
