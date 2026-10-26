/**
 * 「打开远程桌面」对话框：选协议与端口 → 起临时隧道 → 拉起本机客户端。
 *
 * - RDP（默认 3389）：Windows 自带 mstsc，一键即用；
 * - VNC（默认 5900）：交给系统对 vnc:// 的关联程序（需自装 Viewer）。
 *
 * 隧道复用 tunnel_open（连接参数与终端同源；随窗口关闭自动回收），
 * 本地端口由后端随机分配。
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Modal,
  Typography
} from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import { buildSshTarget } from "@/sessions/lib/sshTarget";
import { loadSessions } from "@/sessions/lib/useSessions";
import type { SavedSession } from "@/sessions/lib/session";
import { logError } from "@/shared/lib/log";
import SettingsSelect from "@/settings/components/SettingsSelect";

/** tunnel_open 的返回（本地端口在其中）。 */
type TunnelInfo = {
  id: string;
  localPort: number;
  remotePort: number;
  target: string;
};

export default function RemoteDesktopDialog({
  session,
  onClose
}: {
  session: SavedSession;
  onClose: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<"rdp" | "vnc">(
    "rdp"
  );
  const [port, setPort] = useState("3389");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function switchKind(next: "rdp" | "vnc") {
    setKind(next);
    // 端口跟着协议走（用户改过就别覆盖了——只有等于上一档默认才换）
    setPort(previous =>
      previous === "3389" || previous === "5900"
        ? next === "rdp"
          ? "3389"
          : "5900"
        : previous
    );
  }

  async function connect() {
    const remotePort = Number(port);
    if (
      !remotePort ||
      remotePort < 1 ||
      remotePort > 65535
    ) {
      setError(t("rdp.badPort"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const target = await buildSshTarget(
        session,
        loadSessions()
      );
      // 隧道：本地随机端口 → 服务器的 remotePort
      const tunnel = await invoke<TunnelInfo>(
        "tunnel_open",
        {
          config: {
            ...target,
            id: `rdp-${session.id}`
          },
          remotePort
        }
      );
      await invoke("launch_rdp_client", {
        kind,
        localPort: tunnel.localPort
      });
      onClose();
    } catch (reason) {
      logError(
        "[remote-desktop] 打开失败",
        reason
      );
      setError(String(reason));
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog className="session-dialog">
            <Modal.Header>
              <Typography.Paragraph
                size="sm"
                className="dialog-eyebrow"
              >
                {t("rdp.title")}
              </Typography.Paragraph>
              <Modal.Heading>
                {session.name}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body className="dialog-scroll">
              <div className="jump-host-field">
                <span className="form-label">
                  {t("rdp.protocol")}
                </span>
                <SettingsSelect
                  value={kind}
                  ariaLabel={t("rdp.protocol")}
                  options={[
                    {
                      value: "rdp",
                      label: "RDP (3389)"
                    },
                    {
                      value: "vnc",
                      label: "VNC (5900)"
                    }
                  ]}
                  onChange={next =>
                    switchKind(
                      next as "rdp" | "vnc"
                    )
                  }
                />
                <p className="dialog-hint">
                  {t("rdp.hint")}
                </p>
              </div>
              <div className="jump-host-field">
                <span className="form-label">
                  {t("rdp.port")}
                </span>
                <input
                  className="settings-input"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={event =>
                    setPort(event.target.value)
                  }
                />
                <p className="dialog-hint">
                  {t("rdp.portHint")}
                </p>
              </div>
              {error && (
                <p className="dialog-error">
                  {error}
                </p>
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
                isDisabled={busy}
                onPress={() => void connect()}
              >
                {busy
                  ? t("rdp.connecting")
                  : t("rdp.connect")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
