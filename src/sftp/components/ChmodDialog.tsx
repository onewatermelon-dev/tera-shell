import { Fragment, useState } from "react";
import {
  Button,
  Modal,
  Typography
} from "@heroui/react";

/** 权限分组（所有者 / 所属组 / 其他）与对应位移。 */
const GROUPS = [
  { label: "所有者", shift: 6 },
  { label: "所属组", shift: 3 },
  { label: "其他", shift: 0 }
];

/** 每组里的三个权限位（读 / 写 / 执行）。 */
const BITS = [
  { label: "读", bit: 4 },
  { label: "写", bit: 2 },
  { label: "执行", bit: 1 }
];

/** 权限位格式化成 `rwxr-xr--`。 */
function formatSymbolic(mode: number): string {
  return GROUPS.map(({ shift }) =>
    BITS.map(({ bit }, index) =>
      (mode >> shift) & bit ? "rwx"[index] : "-"
    ).join("")
  ).join("");
}

/** 权限位格式化成八进制（如 `755`）。 */
function formatOctal(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}

type ChmodDialogProps = {
  /** 目标名称，用于标题文案 */
  name: string;
  /** 当前权限（可以是含文件类型位的 st_mode） */
  current: number;
  onConfirm: (mode: number) => void;
  onClose: () => void;
};

/**
 * 权限修改对话框：按「所有者 / 所属组 / 其他」三组勾选读、写、执行，
 * 底部实时显示 `rwx` 符号与八进制值。
 *
 * 与其它对话框一致：父级条件渲染，`isOpen` 恒真、关闭由父级卸载。
 */
export default function ChmodDialog({
  name,
  current,
  onConfirm,
  onClose
}: ChmodDialogProps) {
  // 只保留低 9 位：st_mode 里还带着文件类型位
  const [mode, setMode] = useState(
    current & 0o777
  );

  function toggle(shift: number, bit: number) {
    setMode(
      previous => previous ^ (bit << shift)
    );
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
          <Modal.Dialog className="chmod-dialog">
            <Modal.Header>
              <Typography.Paragraph
                size="sm"
                className="dialog-eyebrow"
              >
                权限修改
              </Typography.Paragraph>
              <Modal.Heading>
                修改「{name}」的权限
              </Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭" />
            </Modal.Header>
            <Modal.Body className="chmod-body">
              <div className="chmod-grid">
                <span className="chmod-corner" />
                {BITS.map(item => (
                  <span
                    key={item.label}
                    className="chmod-head"
                  >
                    {item.label}
                  </span>
                ))}
                {GROUPS.map(group => (
                  <Fragment key={group.label}>
                    <span className="chmod-group">
                      {group.label}
                    </span>
                    {BITS.map(item => (
                      <label
                        key={item.label}
                        className="chmod-cell"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(
                            (mode >>
                              group.shift) &
                            item.bit
                          )}
                          onChange={() =>
                            toggle(
                              group.shift,
                              item.bit
                            )
                          }
                        />
                      </label>
                    ))}
                  </Fragment>
                ))}
              </div>
              <div className="chmod-preview">
                <code>
                  {formatSymbolic(mode)}
                </code>
                <span>({formatOctal(mode)})</span>
              </div>
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
                onPress={() => {
                  onConfirm(mode);
                  onClose();
                }}
              >
                保存
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
