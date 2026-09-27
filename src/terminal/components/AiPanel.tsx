import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { ThinkingState } from "@aicss/react/thinking-state";
import { InfoCircleOutlined } from "@ant-design/icons";
import { ReasoningBlock } from "@/terminal/components/aicss/ReasoningBlock";
import { PromptInput } from "@/terminal/components/aicss/PromptInput";
import type { ExecCardMode } from "@/terminal/lib/aiChat";
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
  /** mode：terminal = 写入活动终端；background = 独立 exec 通道 */
  onConfirm: (mode: ExecCardMode) => void;
  onSkip: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const badge = call.isReadOnly
    ? t("ai.card.ro")
    : t("ai.card.rw");
  // 终端执行的命令拿不到退出码（-1 为未知），此时不展示括号
  // 完成态不展示退出码：命令是否成功由输出和模型解读决定
  const stateText =
    call.state === "running"
      ? t("ai.card.running")
      : call.state === "done"
        ? t("ai.card.done")
        : call.state === "failed"
          ? t("ai.card.failed")
          : awaitingConfirm
            ? t("ai.card.waiting")
            : "";

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(
        call.command
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默：低频辅助操作 */
    }
  }

  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <span className="ai-card-title">
          {t("ai.card.title")}
        </span>
        <span
          className={`ai-card-badge ${
            call.isReadOnly ? "ro" : "rw"
          }`}
        >
          {badge}
        </span>
      </div>
      <pre className="ai-card-command">
        {call.command}
      </pre>
      {call.question && (
        <div className="ai-card-question">
          <InfoCircleOutlined />
          {call.question}
        </div>
      )}
      <div className="ai-card-actions">
        <button
          type="button"
          className="ai-card-btn"
          onClick={() => void copyCommand()}
        >
          {copied
            ? t("ai.card.copied")
            : t("ai.card.copy")}
        </button>
        {awaitingConfirm && (
          <>
            <button
              type="button"
              className="ai-card-btn"
              disabled={busy}
              onClick={onSkip}
            >
              {t("ai.card.skip")}
            </button>
            <button
              type="button"
              className="ai-card-btn is-wide"
              disabled={busy}
              onClick={() =>
                onConfirm("terminal")
              }
            >
              ▶ {t("ai.card.execute")}
            </button>
            <button
              type="button"
              className="ai-card-btn is-primary is-wide"
              disabled={busy}
              onClick={() =>
                onConfirm("background")
              }
            >
              {t("ai.card.background")}
            </button>
          </>
        )}
        {!awaitingConfirm &&
          (call.state === "running" ||
            call.state === "failed" ||
            call.error) && (
            <span className="ai-card-state">
              {stateText}
            </span>
          )}
        {!awaitingConfirm &&
          call.state === "done" && (
            <span className="ai-card-state">
              {stateText}
            </span>
          )}
      </div>
      {(call.state === "done" ||
        call.state === "failed") && (
        <details className="ai-card-result">
          <summary>{t("ai.card.result")}</summary>
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
      {call.state === "failed" && call.error && (
        <div className="ai-card-state is-error">
          {call.error}
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
    stream,
    send,
    confirm,
    skip,
    clear
  } = useAiChat(session);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 新消息 / 状态变化后滚到底部，聊天面板的默认阅读位置在最新一条
  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, error, pendingCardId, stream]);

  function pickModel(value: string) {
    setSelectedKey(value);
    saveSelectedModel(value);
  }

  return (
    <aside className="ai-panel">
      <div className="ai-panel-head">
        <span>{t("ai.title")}</span>
        <div className="ai-panel-head-actions">
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
                onConfirm={mode =>
                  void confirm(
                    entry.call.id,
                    selected,
                    mode
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
                {entry.reasoning && (
                  <ReasoningBlock
                    reasoning={entry.reasoning}
                    elapsedSeconds={
                      entry.elapsedSeconds ?? 1
                    }
                  />
                )}
                {entry.text && (
                  <Streamdown>
                    {entry.text}
                  </Streamdown>
                )}
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
        {stream && (
          // 流式进行中的临时条目：思考内容实时增长，正文就绪后交给 Streamdown
          <div className="ai-entry is-assistant">
            {stream.reasoning ? (
              <div className="ai-live-reasoning">
                <div className="ai-live-reasoning-head">
                  <ThinkingState />
                </div>
                <pre>{stream.reasoning}</pre>
              </div>
            ) : (
              !stream.text && <ThinkingState />
            )}
            {stream.text && (
              <Streamdown>
                {stream.text}
              </Streamdown>
            )}
          </div>
        )}
        {error && (
          <p className="ai-entry is-error">
            {error}
          </p>
        )}
      </div>
      {/* 输入框：@aicss/react PromptInput 改造版，模型选择在「+」菜单里 */}
      <div className="ai-panel-compose">
        <PromptInput
          models={options.map(option => ({
            id: `${option.providerId}::${option.modelId}`,
            name: option.label
          }))}
          modelId={
            selected
              ? `${selected.providerId}::${selected.modelId}`
              : ""
          }
          onModelChange={pickModel}
          busy={busy}
          placeholder={t("ai.input")}
          onSend={text =>
            void send(text, selected)
          }
        />
      </div>
    </aside>
  );
}
