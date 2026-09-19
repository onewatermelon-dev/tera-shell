import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExportOutlined } from "@ant-design/icons";
import {
  Button,
  Form,
  Input,
  Label,
  Modal,
  TextField,
  Typography
} from "@heroui/react";
import {
  emptySshSession,
  type SavedSession
} from "@/sessions/lib/session";
import { useT } from "@/settings/lib/i18n";

type Props = {
  open: boolean;
  session?: SavedSession | null;
  onClose: () => void;
  onSave: (session: SavedSession) => void;
};

export default function SessionDialog({
  open,
  session,
  onClose,
  onSave
}: Props) {
  const t = useT();
  // 通过 key 强制重装，无需 effect 重置状态
  const [form, setForm] = useState(() => {
    if (session) return { ...session };
    const fresh = emptySshSession();
    delete (fresh as Partial<SavedSession>)
      .password;
    return fresh;
  });
  const [error, setError] = useState("");
  const [newPassword, setNewPassword] =
    useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.host.trim()) {
      setError(t("session.hostRequired"));
      return;
    }
    const next: SavedSession = {
      ...form,
      name: form.name.trim() || form.host.trim(),
      username: form.username.trim() || "root"
    };
    // 编辑会话时新填的密码加密后写回；留空保持原密码。
    if (newPassword) {
      try {
        next.password = await invoke<string>(
          "encrypt",
          {
            plain: newPassword
          }
        );
      } catch (reason) {
        setError(String(reason));
        return;
      }
    }
    onSave(next);
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
                  {session
                    ? t("session.editTitle")
                    : t("session.newTitle")}
                </Typography.Paragraph>
                <Modal.Heading>
                  {t("session.eyebrow")}
                </Modal.Heading>
                <Modal.CloseTrigger
                  aria-label={t(
                    "app.action.close"
                  )}
                />
              </Modal.Header>
              <Modal.Body className="dialog-fields">
                <TextField
                  name="name"
                  value={form.name}
                  onChange={v =>
                    setForm({ ...form, name: v })
                  }
                >
                  <Label>
                    {t("session.name")}
                  </Label>
                  <Input
                    autoFocus
                    placeholder={t(
                      "session.namePlaceholder"
                    )}
                  />
                </TextField>
                <div className="form-row">
                  <TextField
                    className="grow"
                    name="host"
                    value={form.host}
                    onChange={v =>
                      setForm({
                        ...form,
                        host: v
                      })
                    }
                  >
                    <Label>
                      {t("session.host")}
                    </Label>
                    <Input placeholder="192.168.1.10" />
                  </TextField>
                  <TextField
                    name="port"
                    className="port-field"
                    value={String(form.port)}
                    onChange={v =>
                      setForm({
                        ...form,
                        port: Number(v) || 0
                      })
                    }
                  >
                    <Label>
                      {t("session.port")}
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                    />
                  </TextField>
                </div>
                <TextField
                  name="username"
                  value={form.username}
                  onChange={v =>
                    setForm({
                      ...form,
                      username: v
                    })
                  }
                >
                  <Label>
                    {t("session.username")}
                  </Label>
                  <Input placeholder="root" />
                </TextField>
                {session && form.password && (
                  <TextField
                    name="password"
                    value={newPassword}
                    onChange={setNewPassword}
                  >
                    <Label>
                      {t("session.password")}
                    </Label>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder={t(
                        "session.passwordPlaceholder"
                      )}
                    />
                  </TextField>
                )}
                <Typography.Paragraph
                  size="sm"
                  className="dialog-hint"
                >
                  {t("session.authHint")}
                </Typography.Paragraph>
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
                  <ExportOutlined />
                  {t("session.save")}
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
