/**
 * MCP 命令执行的审批：监听后端 `mcp-approval-request` 事件，把待审批的
 * 命令交给全局审批弹窗；用户点「执行 / 拒绝」后 invoke 回传决定。
 *
 * 外部 agent 经 MCP 发起 `tera_run_command` 时，主进程会阻塞在这条命令上
 * 等决定（oneshot，超时 5 分钟自动拒绝）。前端这里只负责「收事件 → 弹窗 →
 * 回传」，不关心命令最终执行结果（那是主进程回给子进程的）。
 *
 * 队列模型：可能有多个外部 agent 同时发起，但审批弹窗一次只显示一条
 * （当前处理队列头部），避免多张卡叠在一起。
 */
import {
  useCallback,
  useEffect,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 一条待审批请求（字段与后端 ApprovalRequest 对齐，camelCase）。 */
export type McpApprovalRequest = {
  requestId: string;
  /** 目标服务器（`user@host:port`） */
  target: string;
  /** 命令原文 */
  command: string;
  /** 外部 agent 自报是否只读 */
  isReadOnly: boolean;
  /** 发起调用的客户端名 */
  client: string;
};

/** 事件名，与后端 bridge.rs 的 emit 逐字一致。 */
const APPROVAL_EVENT = "mcp-approval-request";

/**
 * 订阅 MCP 审批事件，维护待审批队列。
 *
 * 返回：
 * - `pending`：当前要展示的审批请求（队列头部；无则 null）
 * - `respond`：回传决定（approved / rejected）
 * - `dismiss`：本地移除当前请求（超时兜底，通常不需要手动调）
 */
export function useMcpApproval() {
  const [queue, setQueue] = useState<
    McpApprovalRequest[]
  >([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // listen 返回 Promise，卸载时要正确摘掉监听
    listen<McpApprovalRequest>(
      APPROVAL_EVENT,
      event => {
        if (disposed) return;
        setQueue(prev => [
          ...prev,
          event.payload
        ]);
      }
    )
      .then(fn => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(reason => {
        console.error(
          "[mcp] 订阅审批事件失败",
          reason
        );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /** 回传决定并移除队列头部那条。 */
  const respond = useCallback(
    async (
      requestId: string,
      decision: "approved" | "rejected"
    ) => {
      try {
        await invoke("mcp_approval_respond", {
          requestId,
          decision
        });
      } catch (reason) {
        // 未命中 pending（已超时）时后端返回 false，不抛；这里兜底记日志
        console.warn(
          "[mcp] 回传审批决定失败",
          reason
        );
      }
      setQueue(prev =>
        prev.filter(
          item => item.requestId !== requestId
        )
      );
    },
    []
  );

  /** 本地移除一条（超时 / 主进程已关闭时的兜底清理）。 */
  const dismiss = useCallback(
    (requestId: string) => {
      setQueue(prev =>
        prev.filter(
          item => item.requestId !== requestId
        )
      );
    },
    []
  );

  return {
    pending: queue[0] ?? null,
    respond,
    dismiss
  };
}
