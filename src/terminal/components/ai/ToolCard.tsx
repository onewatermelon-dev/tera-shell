/**
 * 执行卡片的可见文本与操作。
 *
 * 从 AiPanel.tsx 拆出（2026-10-13）：卡片自身不持有面板状态，
 * 全部经 props 注入，可独立阅读与测试。
 */
import { useState } from "react";
import { InfoCircleOutlined } from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import type {
  AiToolCall,
  ExecCardMode
} from "@/terminal/lib/ai/aiChat";

/** 执行卡片的可见文本与操作。 */
export function ToolCard({
  call,
  awaitingConfirm,
  busy,
  onConfirm,
  onSkip,
  onAddMacro
}: {
  call: AiToolCall;
  awaitingConfirm: boolean;
  busy: boolean;
  /** mode：terminal = 写入活动终端；background = 独立 exec 通道 */
  onConfirm: (mode: ExecCardMode) => void;
  onSkip: () => void;
  /** 把这条命令存为快捷宏 */
  onAddMacro: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [macroAdded, setMacroAdded] =
    useState(false);
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
          title={
            call.isReadOnly
              ? t("ai.badge.ro")
              : t("ai.badge.rw")
          }
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
          {/* question 由模型生成，同样可能带出工具内部标识 */}
          {sanitizeToolNames(call.question)}
        </div>
      )}
      <div className="ai-card-actions">
        <button
          type="button"
          className="ai-card-btn"
          onClick={() => {
            onAddMacro();
            setMacroAdded(true);
            setTimeout(
              () => setMacroAdded(false),
              1500
            );
          }}
        >
          {macroAdded
            ? t("ai.card.added")
            : t("ai.card.addMacro")}
        </button>
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
