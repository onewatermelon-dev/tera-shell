/**
 * 粘贴确认弹窗：多行 / 危险命令粘进终端前多问一句。
 *
 * 标题带**会话名 + 主机 + 环境色条**（与侧栏色标同源）—— 三个终端标签
 * 并排时，用户很容易把命令粘到生产机那格，色条是最后一道视觉提示。
 *
 * 「本会话不再提示」只作用于当前会话（按 id 记，重连不清），语义上等于
 * 「这台机器我熟」。不提供全局关闭：粘贴防护本身就是防手滑的，
 * 一次性关掉所有机器就失去意义了。
 */
import { useState } from "react";
import { Button, Modal } from "@heroui/react";
import { WarningFilled } from "@ant-design/icons";
import {
  useT,
  type MessageKey
} from "@/settings/lib/i18n";
import {
  colorHex,
  type ColorTag
} from "@/sessions/lib/sessionGroup";
import type {
  PasteAssessment,
  PasteRiskId
} from "@/terminal/lib/pasteGuard";

/** 预览最多显示这么多行，更长的折成「还有 N 行」。 */
const PREVIEW_LINES = 8;
/** 单行预览截断长度：终端里一行几百字符会把弹窗撑爆。 */
const PREVIEW_COL_WIDTH = 120;

/** 风险 id → 文案 key（MessageKey 是字面量联合，不能拼接）。 */
const RISK_TEXT: Record<PasteRiskId, MessageKey> =
  {
    multiline: "terminal.paste.risk.multiline",
    "rm-rf": "terminal.paste.risk.rmRf",
    dd: "terminal.paste.risk.dd",
    mkfs: "terminal.paste.risk.mkfs",
    "chmod-root": "terminal.paste.risk.chmodRoot",
    "fork-bomb": "terminal.paste.risk.forkBomb"
  };

export function PasteGuardDialog({
  sessionName,
  host,
  color,
  text,
  assessment,
  onConfirm,
  onCancel
}: {
  /** 目标会话名（标签上的名字） */
  sessionName: string;
  /** 目标主机标识（`user@host:port`，本地为 local） */
  host: string;
  /** 会话环境色（侧栏色标同源） */
  color?: ColorTag;
  /** 待粘贴原文 */
  text: string;
  assessment: PasteAssessment;
  onConfirm: (skipNextTime: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [skip, setSkip] = useState(false);
  const lines = text.split(/\r?\n/);
  const preview = lines
    .slice(0, PREVIEW_LINES)
    .map(line =>
      line.length > PREVIEW_COL_WIDTH
        ? `${line.slice(0, PREVIEW_COL_WIDTH)}…`
        : line
    )
    .join("\n");
  const rest = Math.max(
    0,
    lines.length - PREVIEW_LINES
  );

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onCancel();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container
          placement="center"
          size="md"
        >
          <Modal.Dialog className="paste-guard-dialog">
            <Modal.Header>
              <Modal.Heading>
                <span className="paste-guard-title">
                  <WarningFilled className="paste-guard-icon" />
                  {t("terminal.paste.title")}
                </span>
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body>
              <p className="paste-guard-target">
                <span
                  className="paste-guard-env"
                  style={{
                    background: colorHex(color)
                  }}
                  aria-hidden="true"
                />
                <span className="paste-guard-where">
                  {sessionName}
                  <span className="paste-guard-host">
                    {host}
                  </span>
                </span>
              </p>
              <p className="paste-guard-lead">
                {t("terminal.paste.lead")}
              </p>
              <ul className="paste-guard-risks">
                {assessment.risks.map(risk => (
                  <li key={risk.id}>
                    {risk.id === "multiline"
                      ? t(RISK_TEXT[risk.id], {
                          lines: risk.lines ?? 0
                        })
                      : t(RISK_TEXT[risk.id])}
                  </li>
                ))}
              </ul>
              <pre className="paste-guard-preview">
                {preview}
                {rest > 0
                  ? `\n${t(
                      "terminal.paste.more",
                      {
                        count: rest
                      }
                    )}`
                  : ""}
              </pre>
              <label className="paste-guard-skip">
                <input
                  type="checkbox"
                  checked={skip}
                  onChange={event =>
                    setSkip(event.target.checked)
                  }
                />
                {t("terminal.paste.skip")}
              </label>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                size="sm"
                onPress={onCancel}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={() => onConfirm(skip)}
              >
                {t("terminal.paste.confirm")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
