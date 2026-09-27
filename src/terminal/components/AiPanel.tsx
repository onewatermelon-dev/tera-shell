import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useT } from "@/settings/lib/i18n";
import {
  listOpenAiModels,
  loadSelectedModel,
  saveSelectedModel,
  useAiChat
} from "@/terminal/lib/aiChat";
import type { AiToolCall } from "@/terminal/lib/aiChat";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

type AiPanelProps = {
  /** 当前激活的 SSH 会话（命令执行目标与上下文来源）。 */
  session: OpenSession;
};

/** 执行卡片的可见文本与操作。 */
function ToolCard({
  call,
  awaitingConfirm,
  busy,
  onConfirm,
  onSkip
}: {
  call: AiToolCall;
  awaitingConfirm: boolean;
  busy: boolean;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const badge = call.isReadOnly
    ? t("ai.card.ro")
    : t("ai.card.rw");
  const stateText =
    call.state === "running"
      ? t("ai.card.running")
      : call.state === "done"
        ? `${t("ai.card.done")} (${call.exitCode})`
        : call.state === "failed"
          ? t("ai.card.failed")
          : awaitingConfirm
            ? t("ai.card.waiting")
            : "";
  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <span
          className={`ai-card-badge ${
            call.isReadOnly ? "ro" : "rw"
          }`}
        >
          {badge}
        </span>
        <span className="ai-card-question">
          {call.question}
        </span>
      </div>
      <pre className="ai-card-command">
        {call.command}
      </pre>
      {(call.state === "done" ||
        call.state === "failed") && (
        <details className="ai-card-result">
          <summary>{stateText}</summary>
          {call.stdout && (
            <pre>{call.stdout}</pre>
          )}
          {call.stderr && (
            <pre className="is-error">
              {call.stderr}
            </pre>
          )}
          {!call.stdout && !call.stderr && (
            <pre>(无输出)</pre>
          )}
        </details>
      )}
      {call.state === "running" && (
        <div className="ai-card-state">
          {stateText}
        </div>
      )}
      {call.state === "failed" && call.error && (
        <div className="ai-card-state is-error">
          {call.error}
        </div>
      )}
      {awaitingConfirm && (
        <div className="ai-card-actions">
          <button
            type="button"
            className="ai-card-btn is-primary"
            disabled={busy}
            onClick={onConfirm}
          >
            {t("ai.card.execute")}
          </button>
          <button
            type="button"
            className="ai-card-btn"
            disabled={busy}
            onClick={onSkip}
          >
            {t("ai.card.skip")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * SSH 会话右侧的 AI 助手面板：模型对话 + run_command 执行卡片。
 *
 * 模型走「模型设置」里 OpenAI 兼容的供应商；命令执行走独立 exec 通道
 * （aiRunCommand），只读命令自动执行，读写命令等用户确认。
 */
export default function AiPanel({
  session
}: AiPanelProps) {
  const t = useT();
  const options = useMemo(
    () => listOpenAiModels(),
    []
  );
  const [selectedKey, setSelectedKey] = useState(
    () => loadSelectedModel() ?? ""
  );
  // 上次选中的模型可能已被删掉：找不到就退回第一个可选项
  const selected =
    options.find(
      o =>
        `${o.providerId}::${o.modelId}` ===
        selectedKey
    ) ??
    options[0] ??
    null;
  const {
    entries,
    busy,
    pendingCardId,
    error,
    send,
    confirm,
    skip,
    clear
  } = useAiChat(session);
  const [draft, setDraft] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // 新消息 / 状态变化后滚到底部，聊天面板的默认阅读位置在最新一条
  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, error, pendingCardId]);

  function pickModel(value: string) {
    setSelectedKey(value);
    saveSelectedModel(value);
  }

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text, selected);
  }

  return (
    <aside className="ai-panel">
      <div className="ai-panel-head">
        <span>{t("ai.title")}</span>
        <div className="ai-panel-head-actions">
          <select
            className="ai-model-select"
            aria-label={t("ai.selectModel")}
            value={
              selected
                ? `${selected.providerId}::${selected.modelId}`
                : ""
            }
            onChange={event =>
              pickModel(event.target.value)
            }
          >
            {selected ? null : (
              <option value="">
                {t("ai.noModel")}
              </option>
            )}
            {options.map(option => (
              <option
                key={`${option.providerId}::${option.modelId}`}
                value={`${option.providerId}::${option.modelId}`}
              >
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ai-panel-clear"
            aria-label={t("ai.clear")}
            title={t("ai.clear")}
            onClick={clear}
          >
            {t("ai.clear")}
          </button>
        </div>
      </div>
      <div
        className="ai-panel-body"
        ref={bodyRef}
      >
        {entries.length === 0 && !error && (
          <p className="ai-panel-empty">
            {t("ai.placeholder")}
          </p>
        )}
        {entries.map((entry, index) => {
          if (entry.kind === "tool") {
            return (
              <ToolCard
                key={entry.call.id}
                call={entry.call}
                awaitingConfirm={
                  pendingCardId === entry.call.id
                }
                busy={busy}
                onConfirm={() =>
                  void confirm(
                    entry.call.id,
                    selected
                  )
                }
                onSkip={() =>
                  void skip(
                    entry.call.id,
                    selected
                  )
                }
              />
            );
          }
          if (entry.kind === "assistant") {
            // 助手回复是 markdown（表格 / 代码块），交给 Streamdown 渲染
            return (
              <div
                key={index}
                className="ai-entry is-assistant"
              >
                <Streamdown>
                  {entry.text}
                </Streamdown>
              </div>
            );
          }
          return (
            <p
              key={index}
              className={`ai-entry is-${entry.kind}`}
            >
              {entry.text}
            </p>
          );
        })}
        {error && (
          <p className="ai-entry is-error">
            {error}
          </p>
        )}
      </div>
      <div className="ai-panel-compose">
        <input
          className="ai-panel-input"
          placeholder={t("ai.input")}
          value={draft}
          disabled={busy}
          onChange={event =>
            setDraft(event.target.value)
          }
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="ai-panel-send"
          disabled={busy || !draft.trim()}
          onClick={submit}
        >
          {t("ai.send")}
        </button>
      </div>
    </aside>
  );
}
