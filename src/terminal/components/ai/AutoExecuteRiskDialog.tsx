/**
 * 开启「自动执行」前的安全确认弹窗：勾选知晓风险后才可确认。
 *
 * 从 AiPanel.tsx 拆出（2026-10-13）。
 */
import { useState } from "react";
import { Button, Modal } from "@heroui/react";
import { WarningFilled } from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";

export function AutoExecuteRiskDialog({
  onConfirm,
  onClose
}: {
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [ack, setAck] = useState(false);
  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container
          placement="center"
          size="sm"
        >
          <Modal.Dialog className="ai-risk-dialog">
            <Modal.Header>
              <Modal.Heading>
                <span className="ai-risk-title">
                  <WarningFilled className="ai-risk-icon" />
                  安全提示
                </span>
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body>
              <p className="ai-risk-lead">
                开启自动执行只读命令存在潜在风险：
              </p>
              <ol className="ai-risk-list">
                <li>
                  命令的“只读”属性是由AI判断的，可能存在判断错误的情况。
                </li>
                <li>
                  自动执行可能导致意料之外的服务器状态变更或数据泄露。
                </li>
              </ol>
              <label className="ai-risk-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={event =>
                    setAck(event.target.checked)
                  }
                />
                我已知晓风险，并同意开启自动执行只读命令功能
              </label>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                size="sm"
                onPress={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={!ack}
                onPress={() => {
                  onConfirm();
                  onClose();
                }}
              >
                确认开启
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
