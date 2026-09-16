import {
  Button,
  Modal,
  Typography
} from "@heroui/react";

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
              <Modal.CloseTrigger aria-label="关闭" />
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
                取消
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
