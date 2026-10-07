import { useState } from "react";
import { FolderAddOutlined } from "@ant-design/icons";
import {
  Button,
  Form,
  Input,
  Label,
  Modal,
  TextField,
  Typography
} from "@heroui/react";
import ColorPicker from "@/sessions/components/ColorPicker";
import {
  emptyGroup,
  normalizeColorTag,
  type SessionGroup
} from "@/sessions/lib/sessionGroup";
import { useT } from "@/settings/lib/i18n";

type Props = {
  open: boolean;
  /** 传入表示重命名已有分组；不传表示新建。 */
  group?: SessionGroup | null;
  onClose: () => void;
  onSave: (group: SessionGroup) => void;
};

/**
 * 新建 / 重命名分组弹窗：名称 + 颜色标记。
 *
 * 提交时把名字 trim 掉；空名直接拦下 —— 分组标题行没名字可显示
 * （groupSessions 会兜成「—」，但那只是防脏数据的显示兜底，不是用户要的）。
 */
export default function GroupDialog({
  open,
  group,
  onClose,
  onSave
}: Props) {
  const t = useT();
  const [name, setName] = useState(
    () => group?.name ?? ""
  );
  const [color, setColor] = useState(
    () => group?.color ?? ""
  );
  const [error, setError] = useState("");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("group.nameRequired"));
      return;
    }
    onSave({
      ...(group ?? emptyGroup()),
      name: trimmed,
      color: normalizeColorTag(color)
    });
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog className="session-dialog">
            <Form onSubmit={submit}>
              <Modal.Header>
                <Typography.Paragraph
                  size="sm"
                  className="dialog-eyebrow"
                >
                  {group
                    ? t("group.editTitle")
                    : t("group.newTitle")}
                </Typography.Paragraph>
                <Modal.Heading>
                  {t("group.title")}
                </Modal.Heading>
                <Modal.CloseTrigger
                  aria-label={t(
                    "app.action.close"
                  )}
                />
              </Modal.Header>
              <Modal.Body className="dialog-fields">
                <TextField
                  name="groupName"
                  value={name}
                  onChange={setName}
                >
                  <Label>{t("group.name")}</Label>
                  <Input
                    autoFocus
                    // 同 SessionDialog：关掉 WebView2 的表单自动填充，
                    // 否则点输入框会弹出浏览器存过的「保存的值」下拉
                    autoComplete="off"
                    placeholder={t(
                      "group.namePlaceholder"
                    )}
                  />
                </TextField>
                <div className="form-row">
                  <span className="form-label">
                    {t("colorTag.label")}
                  </span>
                </div>
                <ColorPicker
                  value={color}
                  onChange={setColor}
                />
                {error && (
                  <Typography.Paragraph
                    size="sm"
                    className="dialog-error"
                  >
                    {error}
                  </Typography.Paragraph>
                )}
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
                  type="submit"
                >
                  <FolderAddOutlined />
                  {t("group.save")}
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
