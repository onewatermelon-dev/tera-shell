import {
  Button,
  Modal,
  Typography
} from "@heroui/react";
import { useT } from "@/settings/lib/i18n";

type ConfirmDialogProps = {
  /** 标题上方的小标签，如"删除" */
  eyebrow: string;
  /** 主标题（一句话说明要做什么） */
  title: string;
  /** 补充说明，通常用来强调后果 */
  description: string;
  /** 确认按钮文案 */
  confirmText: string;
  /** 确认按钮用危险色（删除类操作用） */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * 通用二次确认对话框。
 *
 * 与其它对话框一致：父级条件渲染，`isOpen` 恒真、关闭由父级卸载。
 */
export default function ConfirmDialog({
  eyebrow,
  title,
  description,
  confirmText,
  danger = false,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  // 取消/关闭钮走 i18n：其余文案都由调用方传入，只有这两个原先硬编码中文，
  // 英文界面下会露出中文（删除分组、删除文件那两处都受影响）
  const t = useT();
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
          size="xs"
        >
          <Modal.Dialog className="confirm-dialog">
            <Modal.Header>
              <Typography.Paragraph
                size="sm"
                className="dialog-eyebrow"
              >
                {eyebrow}
              </Typography.Paragraph>
              <Modal.Heading>
                {title}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body>
              <Typography.Paragraph
                size="sm"
                className="confirm-description"
              >
                {description}
              </Typography.Paragraph>
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
                variant={
                  danger ? "danger" : "primary"
                }
                size="sm"
                onPress={() => {
                  onConfirm();
                  onClose();
                }}
              >
                {confirmText}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
