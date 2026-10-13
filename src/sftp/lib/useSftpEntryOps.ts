import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import {
  joinPath,
  type PaneEntry,
  type PaneListing,
  type PaneSide
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

/**
 * 条目级操作：打开 / 新建 / 删除 / 重命名 / 改权限。
 *
 * 本地走 `fs_*` 命令；远程走 `sftp_*` 命令（连接参数由
 * `buildRemoteConnection` 现场组装），远程递归删除会登记成传输
 * 任务走底部面板展示进度。所有会改变目录内容的操作完成后都
 * 强制刷新来源栏（refresh=true，顺带更新后端目录缓存）。
 */
export function useSftpEntryOps({
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
   * 打开一个条目。
   *
   * 本地文件直接交给系统；远程文件本地程序够不着，先拉到临时目录再打开
   * （`sftp_edit_remote` 返回本地路径），之后本地一保存就自动回传远程。
   */
  const openEntry = useCallback(
    async (
      pane: PaneSide,
      entry: PaneEntry,
      withNotepad: boolean
    ) => {
      const target =
        pane === "remote"
          ? await invoke<string>(
              "sftp_edit_remote",
              {
                job: {
                  ...(await buildRemoteConnection(
                    session
                  )),
                  local: "",
                  remote: entry.path
                }
              }
            )
          : entry.path;
      await invoke(
        withNotepad
          ? "fs_open_notepad"
          : "fs_open_path",
        { path: target }
      );
    },
    [session]
  );

  /** 在当前目录下新建文件夹或空文件。 */
  const createEntry = useCallback(
    async (
      pane: PaneSide,
      isDir: boolean,
      name: string
    ) => {
      if (pane === "local") {
        const directory = local?.path;
        if (!directory) {
          throw new Error("本地目录尚未加载");
        }
        await invoke(
          isDir
            ? "fs_make_dir"
            : "fs_create_file",
          { path: joinPath(directory, name) }
        );
        void navigateLocal(directory);
        return;
      }
      const directory = remote?.path;
      if (!directory) {
        throw new Error("远程目录尚未加载");
      }
      const connection =
        await buildRemoteConnection(session);
      await invoke(
        isDir
          ? "sftp_make_dir"
          : "sftp_create_file",
        {
          job: {
            ...connection,
            local: "",
            remote: joinPath(directory, name)
          }
        }
      );
      void navigateRemote(
        session as SavedSession,
        directory,
        true
      );
    },
    [
      remote?.path,
      local?.path,
      session,
      navigateRemote,
      navigateLocal
    ]
  );

  /** 删除单个条目的实际执行：本地直接删，远程递归删并登记任务；不负责刷新。 */
  const removeEntryCore = useCallback(
    async (pane: PaneSide, entry: PaneEntry) => {
      if (pane === "local") {
        await invoke("fs_remove_path", {
          path: entry.path
        });
        return;
      }
      const connection =
        await buildRemoteConnection(session);
      // 远程递归删除可能很慢，登记成一条任务走底部面板展示进度
      const id = tasks.registerTask(
        entry.name,
        "delete",
        entry.size
      );
      try {
        await invoke("sftp_remove_path", {
          job: {
            ...connection,
            id,
            local: "",
            remote: entry.path
          }
        });
      } catch (reason) {
        if (tasks.failTask(id, String(reason)))
          return;
        throw reason;
      }
      tasks.finishTask(id);
    },
    [session, tasks]
  );

  /** 删除完成后刷新来源栏当前目录。 */
  const refreshAfterRemove = useCallback(
    (pane: PaneSide) => {
      if (pane === "local") {
        void navigateLocal(local?.path);
      } else {
        void navigateRemote(
          session as SavedSession,
          remote?.path,
          true
        );
      }
    },
    [
      local?.path,
      remote?.path,
      session,
      navigateLocal,
      navigateRemote
    ]
  );

  /** 删除文件或目录（远程按递归删除，并在底部面板里显示进度）。 */
  const removeEntry = useCallback(
    async (pane: PaneSide, entry: PaneEntry) => {
      await removeEntryCore(pane, entry);
      refreshAfterRemove(pane);
    },
    [removeEntryCore, refreshAfterRemove]
  );

  /** 批量删除：逐项执行（远程每项一条任务进面板），完成后只刷新一次。 */
  const removeEntries = useCallback(
    async (
      pane: PaneSide,
      entries: PaneEntry[]
    ) => {
      for (const entry of entries) {
        // 单项失败即中断：后续项很可能依赖同一故障（如权限），继续只是刷屏
        await removeEntryCore(pane, entry);
      }
      refreshAfterRemove(pane);
    },
    [removeEntryCore, refreshAfterRemove]
  );

  /** 重命名文件或目录：新名字拼在原目录后面，目录本身不变。 */
  const renameEntry = useCallback(
    async (
      pane: PaneSide,
      entry: PaneEntry,
      name: string
    ) => {
      const directory =
        pane === "local"
          ? local?.path
          : remote?.path;
      if (!directory) {
        throw new Error(
          pane === "local"
            ? "本地目录尚未加载"
            : "远程目录尚未加载"
        );
      }
      const from = entry.path;
      const to = joinPath(directory, name);
      if (from === to) return;
      if (pane === "local") {
        await invoke("fs_rename_path", {
          from,
          to
        });
        void navigateLocal(directory);
        return;
      }
      const connection =
        await buildRemoteConnection(session);
      await invoke("sftp_rename_path", {
        request: { ...connection, from, to }
      });
      void navigateRemote(
        session as SavedSession,
        directory,
        true
      );
    },
    [
      remote?.path,
      local?.path,
      session,
      navigateRemote,
      navigateLocal
    ]
  );

  /** 修改一批远程条目的权限（Unix 概念，仅远程栏使用），完成后只刷新一次。 */
  const changeModes = useCallback(
    async (
      entries: PaneEntry[],
      mode: number
    ) => {
      const directory = remote?.path;
      const connection =
        await buildRemoteConnection(session);
      for (const entry of entries) {
        await invoke("sftp_chmod", {
          job: {
            ...connection,
            local: "",
            remote: entry.path
          },
          mode
        });
      }
      void navigateRemote(
        session as SavedSession,
        directory,
        true
      );
    },
    [remote?.path, session, navigateRemote]
  );

  /** 修改远程文件 / 目录的权限（Unix 概念，仅远程栏使用）。 */
  const changeMode = useCallback(
    async (entry: PaneEntry, mode: number) => {
      await changeModes([entry], mode);
    },
    [changeModes]
  );

  return {
    openEntry,
    createEntry,
    removeEntry,
    removeEntries,
    renameEntry,
    changeMode,
    changeModes
  };
}
