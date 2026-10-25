/**
 * MCP 命令审批弹窗：外部 agent 要在某台服务器上跑命令时，在这里让用户
 * 亲自点「执行 / 拒绝」。
 *
 * 视觉对齐 AI 面板的 ToolCard（只读/读写徽章、命令原文、执行说明），但
 * 是**全局弹窗**（挂 App 根层）——因为外部 agent 触发时用户未必在 AI
 * 面板，弹窗必须在任意界面可见。
 */
import { Button, Modal } from "@heroui/react";
import { InfoCircleOutlined } from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import type { McpApprovalRequest } from "@/terminal/lib/mcp/useMcpApproval";

export function McpApprovalDialog({
  request,
  onApprove,
  onReject
}: {
  request: McpApprovalRequest;
  onApprove: () => void;
  onReject: () => void;
}) {
  const t = useT();
  const badge = request.isReadOnly
    ? t("ai.card.ro")
    : t("ai.card.rw");

  return (
    <Modal
      isOpen
      onOpenChange={() => {
        // 只允许通过按钮关闭：审批必须显式决定，不许点遮罩 / Esc 逃逸
      }}
    >
      <Modal.Backdrop>
        <Modal.Container
          placement="center"
          size="md"
        >
          <Modal.Dialog className="mcp-approval-dialog">
            <Modal.Header>
              <Modal.Heading>
                <span className="mcp-approval-head">
                  <span className="mcp-approval-title">
                    {t("mcp.approval.title")}
                  </span>
                  <span
                    className={`ai-card-badge ${
                      request.isReadOnly
                        ? "ro"
                        : "rw"
                    }`}
                  >
                    {badge}
                  </span>
                </span>
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="mcp-approval-target">
                {request.client
                  ? t("mcp.approval.from", {
                      client: request.client
                    })
                  : t("mcp.approval.external")}
                {t("mcp.approval.target", {
                  target: request.target
                })}
              </div>
              <pre className="mcp-approval-command">
                {request.command}
              </pre>
              <div className="mcp-approval-hint">
                <InfoCircleOutlined />
                <span>
                  {request.isReadOnly
                    ? t(
                        "mcp.approval.readonlyHint"
                      )
                    : t("mcp.approval.writeHint")}
                </span>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                size="sm"
                onPress={onReject}
              >
                {t("mcp.approval.reject")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={onApprove}
              >
                {t("mcp.approval.approve")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
