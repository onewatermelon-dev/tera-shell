import { useState } from "react";
import {
  Button,
  Modal,
  Typography
} from "@heroui/react";

type RenameDialogProps = {
  /** 当前名称，用作输入框的初始值 */
  name: string;
  /** 确认重命名；next 是用户输入的新名称 */
  onConfirm: (next: string) => void;
  onClose: () => void;
};

/**
 * 重命名对话框：把当前名称填进输入框供修改。
 *
 * 与 NewEntryDialog 一致：父级条件渲染，`isOpen` 恒真、关闭由父级卸载。
 * 只改名字不改所在目录——目标路径由调用方按当前目录拼出来。
 */
export default function RenameDialog({
  name,
  onConfirm,
  onClose
}: RenameDialogProps) {
  const [value, setValue] = useState(name);
  // 未改动时禁用确认：避免提交一个一模一样的名字
  const trimmed = value.trim();
  const changed =
    trimmed !== "" && trimmed !== name;

  function submit() {
    if (!changed) return;
    onConfirm(trimmed);
    onClose();
  }

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
          <Modal.Dialog className="new-entry-dialog">
            <Modal.Header>
              <Typography.Paragraph
                size="sm"
                className="dialog-eyebrow"
              >
                重命名
              </Typography.Paragraph>
              <Modal.Heading>
                重命名「{name}」
              </Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭" />
            </Modal.Header>
            <Modal.Body className="new-entry-body">
              <input
                className="new-entry-name"
                value={value}
                autoFocus
                spellCheck={false}
                aria-label="新名称"
                onChange={event =>
                  setValue(event.target.value)
                }
                onKeyDown={event => {
                  if (event.key === "Enter")
                    submit();
                }}
                onFocus={event =>
                  event.currentTarget.select()
                }
              />
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
                variant="primary"
                size="sm"
                isDisabled={!changed}
                onPress={submit}
              >
                重命名
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
