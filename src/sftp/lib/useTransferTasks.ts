import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  TRANSFER_LIMIT,
  newTransferId,
  type TransferControlAction,
  type TransferDirection,
  type TransferEvent,
  type TransferTask
} from "@/sftp/lib/sftpUtils";

/**
 * 传输任务面板的数据源。
 *
 * 负责任务的登记、后端进度事件订阅与暂停 / 恢复 / 取消；真正的传输由调用方
 * 发起，这里只跟踪它们的生命周期。
 */
export function useTransferTasks() {
  const [transfers, setTransfers] = useState<
    TransferTask[]
  >([]);
  // 用户主动取消的任务 id：后端抛出的"已取消"不该算失败
  const cancelledRef = useRef(new Set<string>());

  // 订阅后端进度事件；卸载时取消订阅
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<TransferEvent>(
      "sftp-transfer",
      event => {
        const { id, bytes, total, done } =
          event.payload;
        setTransfers(previous =>
          previous.map(task =>
            task.id === id
              ? {
                  ...task,
                  bytes,
                  // 事件里的总量可能比列表里更准，非 0 时覆盖
                  total: total || task.total,
                  status: done
                    ? "done"
                    : "running",
                  endedAt: done
                    ? Date.now()
                    : task.endedAt
                }
              : task
          )
        );
      }
    ).then(unlisten => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  /** 登记一条新任务，返回它的 id（需要一并带给后端）。 */
  const registerTask = useCallback(
    (
      name: string,
      direction: TransferDirection,
      total: number
    ) => {
      const id = newTransferId();
      setTransfers(previous => [
        ...previous.slice(-(TRANSFER_LIMIT - 1)),
        {
          id,
          name,
          direction,
          status: "running",
          bytes: 0,
          total,
          startedAt: Date.now()
        }
      ]);
      return id;
    },
    []
  );

  /** 标记任务完成；结束事件通常已标好，这里是兜底。 */
  const finishTask = useCallback((id: string) => {
    setTransfers(previous =>
      previous.map(task =>
        task.id === id &&
        task.status === "running"
          ? {
              ...task,
              status: "done",
              endedAt: Date.now()
            }
          : task
      )
    );
  }, []);

  /**
   * 标记任务失败，并返回它是否其实是被用户取消的。
   *
   * 取消是主动行为、不算失败，调用方据此决定要不要把错误抛给上层展示。
   */
  const failTask = useCallback(
    (id: string, reason: string): boolean => {
      const cancelled =
        cancelledRef.current.delete(id);
      setTransfers(previous =>
        previous.map(task =>
          task.id === id && !cancelled
            ? {
                ...task,
                status: "failed",
                endedAt: Date.now(),
                error: reason
              }
            : task
        )
      );
      return cancelled;
    },
    []
  );

  /** 清空已结束的记录；仍在传输或暂停中的保留。 */
  const clearTransfers = useCallback(() => {
    setTransfers(previous =>
      previous.filter(
        task =>
          task.status === "running" ||
          task.status === "paused"
      )
    );
  }, []);

  /** 暂停 / 恢复 / 取消某个传输任务。 */
  const controlTransfer = useCallback(
    async (
      id: string,
      action: TransferControlAction
    ) => {
      // 先记下来：后端因取消而报错时用它区分"失败"
      if (action === "cancel")
        cancelledRef.current.add(id);
      await invoke(
        action === "pause"
          ? "sftp_pause_transfer"
          : action === "resume"
            ? "sftp_resume_transfer"
            : "sftp_cancel_transfer",
        { id }
      );
      // 控制动作不会立刻带来进度事件，本地状态先跟上
      setTransfers(previous =>
        previous.map(task =>
          task.id === id
            ? {
                ...task,
                status:
                  action === "pause"
                    ? "paused"
                    : action === "resume"
                      ? "running"
                      : "cancelled",
                endedAt:
                  action === "cancel"
                    ? Date.now()
                    : task.endedAt
              }
            : task
        )
      );
    },
    []
  );

  return useMemo(
    () => ({
      transfers,
      registerTask,
      finishTask,
      failTask,
      clearTransfers,
      controlTransfer
    }),
    [
      transfers,
      registerTask,
      finishTask,
      failTask,
      clearTransfers,
      controlTransfer
    ]
  );
}
