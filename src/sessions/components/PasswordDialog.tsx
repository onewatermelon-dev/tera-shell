import { useState } from "react";
import type { SavedSession } from "@/sessions/lib/session";
import {
  Button,
  Form,
  Input,
  Label,
  Modal,
  TextField,
  Typography
} from "@heroui/react";

type Props = {
  session: SavedSession;
  onSubmit: (password: string) => void;
  /**
   * 不走密码，直接用私钥 / ssh-agent 连接。
   *
   * 纯密钥登录的会话不该被这个密码框卡死：设置里配了默认私钥，或
   * 本机 agent 里已有可用身份时，用户需要一条显式的绕行路径。
   */
  onUseKey?: () => void;
  onCancel: () => void;
};

export default function PasswordDialog({
  session,
  onSubmit,
  onUseKey,
  onCancel
}: Props) {
  const [password, setPassword] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    onSubmit(password);
  }

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onCancel();
      }}
    >
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container placement="center">
          <Modal.Dialog className="password-dialog">
            <Form onSubmit={submit}>
              <Modal.Header>
                <Typography.Paragraph
                  size="sm"
                  className="dialog-eyebrow"
                >
                  SSH 认证
                </Typography.Paragraph>
                <Modal.Heading>
                  {session.username}@
                  {session.host}:{session.port}
                </Modal.Heading>
                <Modal.CloseTrigger aria-label="取消" />
              </Modal.Header>
              <Modal.Body>
                <TextField
                  name="password"
                  value={password}
                  onChange={setPassword}
                >
                  <Label>密码</Label>
                  <Input
                    autoFocus
                    type="password"
                    autoComplete="off"
                    placeholder="输入密码，将加密保存在本机"
                  />
                </TextField>
                <Typography.Paragraph
                  size="sm"
                  className="dialog-hint"
                >
                  密码使用 Windows
                  系统凭据加密后保存在本机，
                  下次连接无需再次输入。
                </Typography.Paragraph>
                {onUseKey && (
                  <Button
                    type="button"
                    variant="tertiary"
                    size="sm"
                    onPress={onUseKey}
                  >
                    使用私钥 / ssh-agent 连接
                  </Button>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="tertiary"
                  size="sm"
                  onPress={onCancel}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  type="submit"
                  isDisabled={!password}
                >
                  连接
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
