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
  applyTransferEvent,
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
export function useTransferTasks(
  onFinished?: (
    summary: string,
    succeeded: boolean
  ) => void
) {
  const [transfers, setTransfers] = useState<
    TransferTask[]
  >([]);
  // 用户主动取消的任务 id：后端抛出的"已取消"不该算失败
  const cancelledRef = useRef(new Set<string>());
  // 已发过结束通知的任务 id：避免同一个任务重复弹通知
  const notifiedRef = useRef(new Set<string>());

  // 订阅后端进度事件；卸载时取消订阅
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<TransferEvent>(
      "sftp-transfer",
      event => {
        const { id } = event.payload;
        setTransfers(previous =>
          previous.map(task =>
            task.id === id
              ? applyTransferEvent(
                  task,
                  event.payload
                )
              : task
          )
        );
      }
    ).then(unlisten => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  /**
   * 传输结束通知：监视任务状态跃迁到终态的那一刻。
   *
   * ## 为什么用 effect 监视，而不是在事件回调里埋点
   *
   * 任务结束有**两条路径**：后端 `sftp-transfer` 事件（主）与
   * `finishTask` 兜底（后端没发事件的异常情况）。埋在任一处都会漏掉
   * 另一条 —— 症状是「传输完了但没通知」，而用户无从判断这是功能坏了
   * 还是本来就这样，排查成本极高。监视状态跃迁天然覆盖全部路径。
   *
   * `notifiedRef` 保证同一条任务只通知一次：状态会被反复写入
   * （进度事件持续到达），没有它会弹出一长串相同通知。
   */
  useEffect(() => {
    for (const task of transfers) {
      const ended =
        task.status === "done" ||
        task.status === "failed";
      if (!ended) continue;
      if (notifiedRef.current.has(task.id))
        continue;
      notifiedRef.current.add(task.id);
      onFinished?.(
        summarizeTransfer(task),
        task.status === "done"
      );
    }
    // 裁掉已不在列表里的 id（被清空/挤出 TRANSFER_LIMIT），
    // 否则这个 Set 会随会话增长到几百个 id
    const alive = new Set(
      transfers.map(task => task.id)
    );
    for (const id of notifiedRef.current)
      if (!alive.has(id))
        notifiedRef.current.delete(id);
  }, [transfers, onFinished]);

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

  /** 删除单条已结束的记录（行内"删除"按钮）。 */
  const removeTask = useCallback((id: string) => {
    setTransfers(previous =>
      previous.filter(task => task.id !== id)
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
                    : task.endedAt,
                // 暂停记下时刻，恢复时折算成累计暂停时长：
                // 经过时间与速度只统计活跃传输的时间
                pausedAt:
                  action === "pause"
                    ? Date.now()
                    : undefined,
                pausedMs:
                  action === "resume"
                    ? (task.pausedMs ?? 0) +
                      (task.pausedAt
                        ? Date.now() -
                          task.pausedAt
                        : 0)
                    : task.pausedMs
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
      removeTask,
      controlTransfer
    }),
    [
      transfers,
      registerTask,
      finishTask,
      failTask,
      clearTransfers,
      removeTask,
      controlTransfer
    ]
  );
}

/**
 * 传输任务的摘要文本，供系统通知用。
 *
 * 「上传/下载 3 个文件（12.4 MB）」这种带数量与体积的说法，比干巴巴
 * 一个文件名有用 —— 批量传输时要靠它确认是哪一批跑完了。
 */
function summarizeTransfer(
  task: TransferTask
): string {
  const verb =
    task.direction === "upload"
      ? "上传"
      : task.direction === "download"
        ? "下载"
        : "删除";
  // total 是字节数里的「文件总数」还是字节数？由 sftpUtils 约定，
  // 这里只用方向与名字，稳妥起见不臆测 total 的语义
  return task.name
    ? `${verb}：${task.name}`
    : verb;
}
