import { useState } from "react";
import {
  FileOutlined,
  FolderOutlined
} from "@ant-design/icons";
import {
  Button,
  Modal,
  Typography
} from "@heroui/react";

/** 新建类型：文件夹 / 文件。 */
type EntryKind = "dir" | "file";

/** 两种类型的默认名称（改了类型但没改过名称时跟着变）。 */
const DEFAULT_NAME: Record<EntryKind, string> = {
  dir: "新建文件夹",
  file: "新建文件.txt"
};

type NewEntryDialogProps = {
  /** 确认新建；isDir 区分文件夹与文件，name 是用户输入的名称 */
  onCreate: (
    isDir: boolean,
    name: string
  ) => void;
  onClose: () => void;
};

/**
 * 新建对话框：先选类型（文件夹 / 文件），再填名称。
 *
 * 与 PasswordDialog 一致：父级条件渲染，`isOpen` 恒真、关闭由父级卸载。
 */
export default function NewEntryDialog({
  onCreate,
  onClose
}: NewEntryDialogProps) {
  const [kind, setKind] =
    useState<EntryKind>("dir");
  const [name, setName] = useState(
    DEFAULT_NAME.dir
  );
  // 用户是否动过名称：没动过时，切换类型就跟着换默认名
  const [touched, setTouched] = useState(false);

  function switchKind(next: EntryKind) {
    setKind(next);
    if (!touched) setName(DEFAULT_NAME[next]);
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(kind === "dir", trimmed);
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
                新建
              </Typography.Paragraph>
              <Modal.Heading>
                新建文件夹或文件
              </Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭" />
            </Modal.Header>
            <Modal.Body className="new-entry-body">
              <div className="new-entry-kinds">
                <button
                  type="button"
                  className={
                    kind === "dir"
                      ? "kind-option is-active"
                      : "kind-option"
                  }
                  onClick={() =>
                    switchKind("dir")
                  }
                >
                  <FolderOutlined />
                  <span>文件夹</span>
                </button>
                <button
                  type="button"
                  className={
                    kind === "file"
                      ? "kind-option is-active"
                      : "kind-option"
                  }
                  onClick={() =>
                    switchKind("file")
                  }
                >
                  <FileOutlined />
                  <span>文件</span>
                </button>
              </div>
              <input
                className="new-entry-name"
                value={name}
                autoFocus
                spellCheck={false}
                aria-label="名称"
                onChange={event => {
                  setTouched(true);
                  setName(event.target.value);
                }}
                onKeyDown={event => {
                  if (event.key === "Enter")
                    submit();
                }}
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
                isDisabled={!name.trim()}
                onPress={submit}
              >
                创建
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
