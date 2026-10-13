import {
  Button,
  Modal,
  Typography
} from "@heroui/react";
import type {
  PaneEntry,
  TransferPolicy
} from "@/sftp/lib/useSftp";

type TransferPolicyDialogProps = {
  /** 与目标目录同名的冲突条目。 */
  conflicts: PaneEntry[];
  /** 是否存在可续传的冲突（目标同名文件比源小），决定"续传"按钮显隐。 */
  hasResume: boolean;
  /** 用户选定策略；点关闭不回调。 */
  onDecide: (policy: TransferPolicy) => void;
  onClose: () => void;
};

/** 每段最多列出的冲突名，超出的折叠成"等 N 项"。 */
const MAX_NAMES = 8;

/**
 * 传输冲突策略对话框：目标目录已有同名内容时，让用户选
 * 覆盖 / 跳过 / 重命名（/ 续传），选定后整批生效。
 *
 * 与 ConfirmDialog 同一套 Modal 结构；不放"记住我的选择"——
 * 覆盖是破坏性动作，每次都问才安全。
 */
export default function TransferPolicyDialog({
  conflicts,
  hasResume,
  onDecide,
  onClose
}: TransferPolicyDialogProps) {
  const shown = conflicts.slice(0, MAX_NAMES);
  const rest = conflicts.length - shown.length;
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
                传输
              </Typography.Paragraph>
              <Modal.Heading>
                目标目录已有 {conflicts.length}{" "}
                个同名项
              </Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭" />
            </Modal.Header>
            <Modal.Body>
              <ul className="transfer-conflicts">
                {shown.map(entry => (
                  <li
                    key={entry.path}
                    title={entry.name}
                  >
                    {entry.name}
                  </li>
                ))}
                {rest > 0 && (
                  <li className="transfer-conflicts-more">
                    等 {rest} 项…
                  </li>
                )}
              </ul>
              <Typography.Paragraph
                size="sm"
                className="confirm-description"
              >
                覆盖会用新内容替换目标文件；重命名保留两者，新文件自动加序号。
              </Typography.Paragraph>
            </Modal.Body>
            <Modal.Footer className="transfer-policy-footer">
              {hasResume && (
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() =>
                    onDecide("resume")
                  }
                >
                  续传
                </Button>
              )}
              <Button
                variant="tertiary"
                size="sm"
                onPress={() => onDecide("skip")}
              >
                跳过
              </Button>
              <Button
                variant="tertiary"
                size="sm"
                onPress={() => onDecide("rename")}
              >
                重命名
              </Button>
              <Button
                variant="danger"
                size="sm"
                onPress={() =>
                  onDecide("overwrite")
                }
              >
                覆盖
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
