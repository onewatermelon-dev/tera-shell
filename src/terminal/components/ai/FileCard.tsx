/**
 * 文件传输卡片的可见文本与操作。
 *
 * 与 ToolCard 分开：命令卡片展示的是 shell 命令、要走黑名单与自动执行
 * 开关；传输卡片展示的是「本地 ⇄ 服务器」两条路径，而且**必然经过系统
 * 弹窗**（本地文件必须用户亲自挑），没有「后台执行」这种选项。
 */
import {
  InfoCircleOutlined,
  CloudUploadOutlined,
  CloudDownloadOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import type { AiFileCall } from "@/terminal/lib/ai/aiChat";

/** 文件传输卡片。 */
export function FileCard({
  call,
  awaitingConfirm,
  busy,
  onConfirm,
  onSkip
}: {
  call: AiFileCall;
  awaitingConfirm: boolean;
  busy: boolean;
  /** 弹系统框选文件并开始传输 */
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const isUpload = call.direction === "upload";
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

  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <span className="ai-card-title">
          {t("ai.file.title")}
        </span>
        <span
          className="ai-card-badge is-file"
          title={
            isUpload
              ? t("ai.file.upload")
              : t("ai.file.download")
          }
        >
          {isUpload ? (
            <CloudUploadOutlined />
          ) : (
            <CloudDownloadOutlined />
          )}
        </span>
      </div>
      {/* 传输两端各占一行：未选文件时本地一侧是提示，不是路径 */}
      <div className="ai-file-paths">
        <div className="ai-file-row">
          <span className="ai-file-side">
            {t("ai.file.local")}
          </span>
          <span className="ai-file-path">
            {call.localName ?? t("ai.file.hint")}
          </span>
        </div>
        <div className="ai-file-row">
          <span className="ai-file-side">
            {t("ai.file.remote")}
          </span>
          <span className="ai-file-path">
            {call.remotePath}
          </span>
        </div>
      </div>
      {call.question && (
        <div className="ai-card-question">
          <InfoCircleOutlined />
          {/* question 由模型生成，同样可能带出工具内部标识 */}
          {sanitizeToolNames(call.question)}
        </div>
      )}
      {call.state === "done" &&
        call.bytes !== undefined && (
          <div className="ai-card-question">
            {t("ai.file.bytes")}:{" "}
            {formatBytes(call.bytes)}
          </div>
        )}
      <div className="ai-card-actions">
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
              className="ai-card-btn is-primary is-wide"
              disabled={busy}
              onClick={onConfirm}
            >
              {t("ai.file.pick")}
            </button>
          </>
        )}
        {!awaitingConfirm && stateText && (
          <span className="ai-card-state">
            {stateText}
          </span>
        )}
      </div>
      {call.state === "failed" && call.error && (
        <div className="ai-card-state is-error">
          {call.error}
        </div>
      )}
    </div>
  );
}

/** 字节数转易读文本；未知大小时给个占位。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (
    value >= 1024 &&
    unit < units.length - 1
  ) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${
    units[unit]
  }`;
}
