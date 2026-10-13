/**
 * 「历史任务」下拉：只列当前服务器的历史，点开可恢复续聊。
 *
 * 从 AiPanel.tsx 拆出（2026-10-13）：开合状态、列表、行内重命名、
 * 点击外部关闭全部自包含，面板只经 props 接入恢复与改名回调。
 */
import {
  useEffect,
  useRef,
  useState
} from "react";
import { HistoryOutlined } from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import {
  deleteHistory,
  loadHistories,
  renameHistory,
  type AiHistory
} from "@/terminal/lib/ai/aiHistory";

export function AiHistoryMenu({
  host,
  onRestore,
  renameCurrent
}: {
  /** 当前会话的服务器地址：只列它的历史 */
  host: string;
  /** 恢复一条历史（替换展示与协议流，继续对话） */
  onRestore: (history: AiHistory) => void;
  /** 列表里改名：若改的正是当前对话，顶栏标题跟着变 */
  renameCurrent: (
    id: string,
    next: string
  ) => void;
}) {
  const t = useT();
  const [historyOpen, setHistoryOpen] =
    useState(false);
  const [histories, setHistories] = useState<
    AiHistory[]
  >([]);
  // 行内重命名的目标历史 id 与草稿
  const [renamingId, setRenamingId] = useState<
    string | null
  >(null);
  const [renameValue, setRenameValue] =
    useState("");
  const historyWrapRef =
    useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (event: PointerEvent) => {
      if (
        !historyWrapRef.current?.contains(
          event.target as Node
        )
      )
        setHistoryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        setHistoryOpen(false);
    };
    document.addEventListener(
      "pointerdown",
      onDown
    );
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener(
        "pointerdown",
        onDown
      );
      document.removeEventListener(
        "keydown",
        onKey
      );
    };
  }, [historyOpen]);

  function toggleHistory() {
    setHistories(
      loadHistories().filter(
        item => item.host === host
      )
    );
    setHistoryOpen(open => !open);
  }

  function commitRename() {
    const id = renamingId;
    if (!id) return;
    setRenamingId(null);
    // 局部名避开组件级的 title（顶栏显示的当前对话标题），
    // 免得读代码时以为改的是顶栏那个
    const next = renameValue.trim().slice(0, 40);
    if (!next) return;
    renameHistory(id, next);
    setHistories(list =>
      list.map(item =>
        item.id === id
          ? { ...item, title: next }
          : item
      )
    );
    // 只有改的正是当前对话时，顶栏标题才会跟着变（由 renameCurrent 判定）
    renameCurrent(id, next);
  }

  return (
    <div
      className="ai-history-wrap"
      ref={historyWrapRef}
    >
      <button
        type="button"
        className="ai-panel-clear"
        aria-label={t("ai.history")}
        title={t("ai.history")}
        aria-expanded={historyOpen}
        onClick={toggleHistory}
      >
        <HistoryOutlined />
      </button>
      {historyOpen && (
        <div
          className="ai-history-menu"
          role="menu"
        >
          {histories.length === 0 && (
            <p className="ai-history-empty">
              {t("ai.history.empty")}
            </p>
          )}
          {histories.map(history => (
            <div
              key={history.id}
              className="ai-history-item"
            >
              {renamingId === history.id ? (
                <input
                  className="ai-history-rename"
                  autoFocus
                  value={renameValue}
                  onChange={event =>
                    setRenameValue(
                      event.target.value
                    )
                  }
                  onKeyDown={event => {
                    if (event.key === "Enter")
                      commitRename();
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setRenamingId(null);
                    }
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="ai-history-name"
                    onClick={() => {
                      onRestore(history);
                      setHistoryOpen(false);
                    }}
                  >
                    {history.title}
                  </button>
                  <span className="ai-history-time">
                    {new Date(
                      history.updatedAt
                    ).toLocaleString("zh-CN", {
                      hour12: false,
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </span>
                  <span className="ai-history-ops">
                    <button
                      type="button"
                      className="ai-history-op"
                      title={t(
                        "ai.history.rename"
                      )}
                      onClick={() => {
                        setRenamingId(history.id);
                        setRenameValue(
                          history.title
                        );
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="ai-history-op"
                      title={t(
                        "ai.history.delete"
                      )}
                      onClick={() => {
                        deleteHistory(history.id);
                        setHistories(list =>
                          list.filter(
                            item =>
                              item.id !==
                              history.id
                          )
                        );
                      }}
                    >
                      ×
                    </button>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
