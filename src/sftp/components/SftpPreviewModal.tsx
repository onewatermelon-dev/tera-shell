/**
 * SFTP 文件内置预览弹层：图片 / 文本双击直接看，不落临时文件。
 *
 * 数据走后端 `sftp_read_preview`（连接池直读，base64，限 2MB 截断）；
 * 图片拼 data URL 交给 <img>，文本解 base64 按 UTF-8 渲染进 <pre>。
 * 大文本只显示前 2MB（后端已截断并标 truncated）。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal, Typography } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import { buildRemoteConnection } from "@/sftp/lib/sftpConnection";
import {
  baseNameOf,
  type PreviewKind
} from "@/sftp/lib/preview";
import type { SavedSession } from "@/sessions/lib/session";
import { logError } from "@/shared/lib/log";

/** 后端返回的预览内容。 */
type PreviewContent = {
  base64: string;
  truncated: boolean;
};

/** base64 → UTF-8 文本（atob 只出 latin1，宽字符要过 TextDecoder）。 */
function decodeUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (
    let index = 0;
    index < binary.length;
    index += 1
  )
    bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** 图片扩展名 → MIME（svg 是 xml，其余按扩展名对应）。 */
function mimeOf(name: string): string {
  const ext =
    name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    avif: "image/avif"
  };
  return map[ext] ?? "application/octet-stream";
}

export function SftpPreviewModal({
  session,
  path,
  kind,
  onClose
}: {
  /** 远程会话（连接信息来源） */
  session: SavedSession;
  /** 远程文件绝对路径 */
  path: string;
  kind: PreviewKind;
  onClose: () => void;
}) {
  const t = useT();
  const [content, setContent] =
    useState<PreviewContent | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    // 复位放进异步回调：effect 体内同步 setState 会触发级联渲染
    // （react-hooks/set-state-in-effect）；弹层每个 path 只挂一次，
    // 闭包初始就是 null，延迟复位等价
    Promise.resolve().then(() => {
      if (!alive) return;
      setContent(null);
      setError("");
    });
    (async () => {
      try {
        const connection =
          await buildRemoteConnection(session);
        const result =
          await invoke<PreviewContent>(
            "sftp_read_preview",
            {
              job: {
                ...connection,
                local: "",
                remote: path
              }
            }
          );
        if (alive) setContent(result);
      } catch (reason) {
        logError(
          "[sftp-preview] 读取失败",
          reason
        );
        if (alive) setError(String(reason));
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, path]);

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog className="sftp-preview-dialog">
            <Modal.Header>
              <Typography.Paragraph
                size="sm"
                className="dialog-eyebrow"
              >
                {kind === "image"
                  ? t("sftp.preview.image")
                  : t("sftp.preview.text")}
              </Typography.Paragraph>
              <Modal.Heading>
                {baseNameOf(path)}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body>
              {error ? (
                <p className="sftp-preview-error">
                  {error}
                </p>
              ) : !content ? (
                <p className="sftp-preview-status">
                  {t("sftp.preview.loading")}
                </p>
              ) : kind === "image" ? (
                <div className="sftp-preview-image-wrap">
                  <img
                    className="sftp-preview-image"
                    src={`data:${mimeOf(path)};base64,${content.base64}`}
                    alt={baseNameOf(path)}
                  />
                </div>
              ) : (
                <>
                  {content.truncated && (
                    <p className="sftp-preview-status">
                      {t(
                        "sftp.preview.truncated"
                      )}
                    </p>
                  )}
                  <pre className="sftp-preview-text">
                    {decodeUtf8(content.base64)}
                  </pre>
                </>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
