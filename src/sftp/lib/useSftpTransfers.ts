import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import {
  joinPath,
  type PaneEntry,
  type PaneListing,
  type PaneSide,
  type TransferControlAction,
  type TransferPolicy
} from "@/sftp/lib/sftpUtils";
import type { useTransferTasks } from "@/sftp/lib/useTransferTasks";
import { buildRemoteConnection } from "@/sftp/lib/sftpConnection";

type TransferTasks = ReturnType<
  typeof useTransferTasks
>;

/** 导航动作的类型：与 useSftpNavigation 的返回对齐。 */
type NavigateActions = {
  navigateLocal: (
    path?: string | null
  ) => Promise<void>;
  navigateRemote: (
    target: SavedSession,
    path?: string | null,
    refresh?: boolean
  ) => Promise<void>;
};

/** 批量传输与传输任务控制（上传 / 下载 / 删除任务共用）。 */
export function useSftpTransfers({
  session,
  local,
  remote,
  tasks,
  navigateLocal,
  navigateRemote
}: {
  session: SavedSession | null;
  local: PaneListing | null;
  remote: PaneListing | null;
  tasks: TransferTasks;
} & NavigateActions) {
  /**
   * 批量传输：把一批条目从来源栏传到目标栏的指定目录（拖拽 / 右键传输 / 跨栏粘贴共用）。
   *
   * ① **目标目录显式传入** —— 拖拽可以落在子目录里，右键菜单的"传输"
   *    永远只传到另一栏的当前目录；
   * ② **不吞异常** —— 单个条目失败不该中断整批，逐个记 console 即可
   *    （传输面板里每条任务各自有成败状态）；
   * ③ **冲突策略** 随 job 传给后端，目录递归里的每个文件都会过一遍；
   *    策略为"跳过"时，顶层冲突条目在这里就地剔除，不给它们登记
   *    注定 0 字节的死任务（目录仍保留，其内部的冲突由后端兜底）。
   *
   * ⚠️ `joinPath` 会沿用目录的分隔符：本地 Windows 是 `\`、远程是 `/`，
   * 传错目录会让拼接结果不对，所以这里不加工序，直接交给它判断。
   */
  const transferEntries = useCallback(
    async (
      from: PaneSide,
      entries: PaneEntry[],
      directory: string,
      policy: TransferPolicy = "overwrite"
    ) => {
      if (entries.length === 0) return;
      if (!directory) {
        throw new Error("目标目录尚未加载");
      }
      // 跳过策略：顶层冲突不进队列（后端对目录内部仍有兜底）
      let pending = entries;
      if (policy === "skip") {
        const targetEntries =
          from === "local"
            ? remote?.entries
            : local?.entries;
        if (targetEntries?.length) {
          const names = new Set(
            targetEntries.map(entry => entry.name)
          );
          pending = entries.filter(
            entry => !names.has(entry.name)
          );
          if (pending.length === 0) return;
        }
      }
      const connection =
        await buildRemoteConnection(session);
      for (const entry of pending) {
        const id = tasks.registerTask(
          entry.name,
          from === "local"
            ? "upload"
            : "download",
          entry.size
        );
        try {
          if (from === "local") {
            await invoke("sftp_upload", {
              job: {
                ...connection,
                id,
                local: entry.path,
                remote: joinPath(
                  directory,
                  entry.name
                ),
                policy
              }
            });
          } else {
            await invoke("sftp_download", {
              job: {
                ...connection,
                id,
                remote: entry.path,
                local: joinPath(
                  directory,
                  entry.name
                ),
                policy
              }
            });
          }
        } catch (reason) {
          // 取消是用户主动行为，不算失败
          if (tasks.failTask(id, String(reason)))
            continue;
          console.error(
            `[sftp] 拖放传输失败：${entry.name}`,
            reason
          );
          continue;
        }
        tasks.finishTask(id);
      }
      // 目标栏刷新，新文件立刻可见。批量只刷一次，
      // 逐条刷会把远程栏的连接锁占满
      if (from === "local") {
        void navigateRemote(
          session as SavedSession,
          directory,
          true
        );
      } else {
        void navigateLocal(directory);
      }
    },
    [
      remote?.entries,
      local?.entries,
      tasks,
      navigateRemote,
      navigateLocal,
      session
    ]
  );

  /** 清空已结束的传输记录；正在传输的保留。 */
  const clearTransfers = tasks.clearTransfers;

  /** 删除单条已结束的传输记录。 */
  const removeTransfer = tasks.removeTask;

  /** 暂停 / 恢复 / 取消某个传输任务。 */
  const controlTransfer = useCallback(
    async (
      id: string,
      action: TransferControlAction
    ) => {
      await tasks.controlTransfer(id, action);
    },
    [tasks]
  );

  return {
    transferEntries,
    clearTransfers,
    removeTransfer,
    controlTransfer
  };
}
