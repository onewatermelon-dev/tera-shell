import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined
} from "@ant-design/icons";
import type { AiQueuedMessage } from "@/terminal/lib/aiChat";
import { useT } from "@/settings/lib/i18n";

/**
 * 一条排队中的用户消息。
 *
 * 出现在输入框正上方：AI 正在生成时用户发的消息不会丢，而是排在这里，
 * 等本轮结束自动接着发。三个操作与消息下方那排一致（复制/编辑/删除），
 * 手感统一。
 *
 * 最左边的手柄可拖动换序。队列默认按发送顺序排，但用户常常连着问三件事、
 * 其中一件最着急 —— 让他能把最关心的挪到最后立刻问。
 * 拖不动的时候至少有键盘出路：手柄可聚焦，↑/↓ 移动一位。
 */
export function QueuedMessageRow({
  message,
  onUpdate,
  onRemove,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onNudge
}: {
  message: AiQueuedMessage;
  onUpdate: (message: AiQueuedMessage) => void;
  onRemove: (id: string) => void;
  /** 本条是否正被拖走（半透明，让用户看清拖的是哪一条）。 */
  dragging?: boolean;
  /** 本条是否是当前落点（描边高亮）。 */
  dropTarget?: boolean;
  /** 在手柄上按下（尚未越过移动阈值）。 */
  onDragStart?: (
    id: string,
    event: ReactPointerEvent<HTMLSpanElement>
  ) => void;
  /** 手柄聚焦后按 ↑/↓，移动一位。 */
  onNudge?: (id: string, delta: -1 | 1) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    message.text
  );
  const [copied, setCopied] = useState(false);
  const inputRef =
    useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    const next = draft.trim();
    // 编辑成空 = 放弃这条：直接删掉，不入队一个永远发不出去的条目
    if (!next && message.images.length === 0) {
      onRemove(message.id);
      return;
    }
    onUpdate({ ...message, text: next });
    setEditing(false);
  }

  function cancel() {
    setDraft(message.text);
    setEditing(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        message.text
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (reason) {
      // 用户预算是"宁可多打日志"，失败路径必须留痕
      console.error(
        "[ai] 复制排队消息失败",
        reason
      );
    }
  }

  return (
    <div
      className="ai-queue-row"
      data-editing={editing || undefined}
      data-dragging={dragging || undefined}
      data-drop-target={dropTarget || undefined}
      data-queued-id={message.id}
    >
      {/* 手柄：6 个点的点阵，hover 变抓手。

          ⚠️ 用 `onPointerDown` 而**不是** HTML5 的 `draggable`。后者依赖
          浏览器内置的拖拽管线与 `dataTransfer`，在 Tauri 的 WebView2 里
          实测整段失效 —— 拖不动，也不报错、控制台干干净净，最难查的那种。
          所以这里跟会话侧栏「拖标签换组」用同一套 pointer 方案：移动
          阈值判定、跟手浮标、落点命中全放在父组件的 window 监听里，
          复用那个已验证能用的实现思路。

          编辑态禁用手柄拖拽：此时手边有 textarea，拖它只会误操作。 */}
      <span
        className="ai-queue-handle"
        role="button"
        tabIndex={0}
        aria-label={t("ai.queue.handle")}
        title={t("ai.queue.handleHint")}
        data-dragging={dragging || undefined}
        data-disabled={editing || undefined}
        onPointerDown={event => {
          // 只认左键：右键/中键在 WebView2 里会触发别的行为
          if (event.button !== 0) return;
          // 顺手掐掉划词与焦点转移，拖动手感才干净
          event.preventDefault();
          if (editing) return;
          onDragStart?.(message.id, event);
        }}
        onKeyDown={event => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            onNudge?.(message.id, -1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onNudge?.(message.id, 1);
          }
        }}
      />
      {editing ? (
        <textarea
          ref={inputRef}
          className="ai-queue-input"
          value={draft}
          rows={2}
          onChange={event =>
            setDraft(event.target.value)
          }
          onKeyDown={event => {
            // Shift+Enter 换行；Enter 直接保存（与输入框一致）
            if (
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              // Esc 取消编辑：恢复原文，不入队
              event.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span className="ai-queue-text">
          {message.text}
        </span>
      )}
      <div className="ai-queue-ops">
        {editing && (
          <>
            <button
              type="button"
              className="ai-queue-op"
              title={t("ai.queue.cancelEdit")}
              aria-label={t(
                "ai.queue.cancelEdit"
              )}
              onMouseDown={event =>
                // 别让 textarea 先 blur 掉还没提交的草稿
                event.preventDefault()
              }
              onClick={cancel}
            >
              ✕
            </button>
            <button
              type="button"
              className="ai-queue-op is-primary"
              title={t("ai.queue.saveEdit")}
              aria-label={t("ai.queue.saveEdit")}
              onMouseDown={event =>
                event.preventDefault()
              }
              onClick={commit}
            >
              ✓
            </button>
          </>
        )}
        {!editing && (
          <>
            <button
              type="button"
              className="ai-queue-op"
              title={
                copied
                  ? t("ai.message.copied")
                  : t("ai.queue.copy")
              }
              aria-label={t("ai.queue.copy")}
              onClick={() => void copy()}
            >
              <CopyOutlined />
            </button>
            <button
              type="button"
              className="ai-queue-op"
              title={t("ai.queue.edit")}
              aria-label={t("ai.queue.edit")}
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
            >
              <EditOutlined />
            </button>
            <button
              type="button"
              className="ai-queue-op is-danger"
              title={t("ai.queue.remove")}
              aria-label={t("ai.queue.remove")}
              onClick={() => onRemove(message.id)}
            >
              <DeleteOutlined />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
