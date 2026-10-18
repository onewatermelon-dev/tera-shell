import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import {
  joinPath,
  type PaneEntry,
  type PaneListing
} from "@/sftp/lib/sftpUtils";
import { buildRemoteConnection } from "@/sftp/lib/sftpConnection";

/**
 * 远程同服务器文件操作：copy（cp -a 复制）/ move（mv 挪动）与归档
 * （tar.gz 打包 / 解压）。
 *
 * 服务端自己执行，数据不过本机。成功后**乐观更新**当前列表
 * （挪动=移除条目，复制=插入占位条目）立即呈现，再后台强制
 * 刷新对账（顺带更新后端目录缓存，防止普通导航读到旧缓存）。
 */
export function useSftpServerOps({
  session,
  remote,
  patchRemoteEntries,
  navigateRemote
}: {
  session: SavedSession | null;
  remote: PaneListing | null;
  patchRemoteEntries: (
    update: (entries: PaneEntry[]) => PaneEntry[]
  ) => void;
  navigateRemote: (
    target: SavedSession,
    path?: string | null,
    refresh?: boolean
  ) => Promise<void>;
}) {
  // 底部进度条：远程 exec 类操作（复制/挪动/压缩/解压）进行中的文案
  const [remoteOpLabel, setRemoteOpLabel] =
    useState<string | null>(null);

  /**
   * 远程同服务器文件操作：copy（cp -a 复制）或 move（mv 挪动）。
   *
   * 服务端自己执行，数据不过本机。成功后**乐观更新**当前列表
   * （挪动=移除条目，复制=插入占位条目）立即呈现，再后台强制
   * 刷新对账（顺带更新后端目录缓存，防止普通导航读到旧缓存）。
   * ⚠️ 刷新可能被 remoteBusyRef 守卫丢掉，那段时间占位元数据
   * （size=0）会多留一会儿，下次任意刷新自然修正。
   */
  const remoteFileOp = useCallback(
    async (
      mode: "copy" | "move",
      entries: PaneEntry[],
      targetDir: string
    ) => {
      if (!entries.length) return;
      setRemoteOpLabel(
        mode === "copy"
          ? `正在复制 ${entries.length} 项…`
          : `正在挪动 ${entries.length} 项…`
      );
      try {
        const connection =
          await buildRemoteConnection(session);
        await invoke("sftp_remote_fs", {
          job: {
            ...connection,
            local: "",
            remote: entries[0]?.path ?? ""
          },
          mode,
          paths: entries.map(entry => entry.path),
          targetDir
        });
        if (mode === "move") {
          // 挪走 = 从当前列表移除（拖拽的来源一定是当前目录）
          const moved = new Set(
            entries.map(entry => entry.path)
          );
          patchRemoteEntries(previous =>
            previous.filter(
              entry => !moved.has(entry.path)
            )
          );
        } else {
          // 复制 = 在目标目录（即当前目录）插入占位条目，
          // size/mtime 未知先置空，刷新对账后变成真实值
          patchRemoteEntries(previous => [
            ...previous,
            ...entries.map(entry => ({
              name: entry.name,
              path: joinPath(
                targetDir,
                entry.name
              ),
              isDir: entry.isDir,
              size: 0,
              modified: null,
              perm: null,
              owner: null,
              group: null,
              iconKey: entry.isDir
                ? "dir"
                : (entry.iconKey ?? undefined)
            }))
          ]);
        }
        if (session) {
          void navigateRemote(
            session as SavedSession,
            remote?.path,
            true
          );
        }
      } finally {
        setRemoteOpLabel(null);
      }
    },
    [
      session,
      remote?.path,
      patchRemoteEntries,
      navigateRemote
    ]
  );

  /**
   * 远程归档：compress（tar.gz 打包）或 extract（解压到所在目录）。
   *
   * 后端走 exec 通道跑 tar / unzip；成功后强制刷新远程当前目录。
   */
  const archiveEntries = useCallback(
    async (
      mode: "compress" | "extract",
      paths: string[],
      target: string
    ) => {
      setRemoteOpLabel(
        mode === "compress"
          ? `正在压缩 ${paths.length} 项…`
          : "正在解压…"
      );
      try {
        const connection =
          await buildRemoteConnection(session);
        await invoke("sftp_archive", {
          job: {
            ...connection,
            local: "",
            remote: paths[0] ?? ""
          },
          mode,
          paths,
          target
        });
        if (session) {
          void navigateRemote(
            session as SavedSession,
            remote?.path,
            true
          );
        }
      } finally {
        setRemoteOpLabel(null);
      }
    },
    [session, remote?.path, navigateRemote]
  );

  return {
    remoteFileOp,
    archiveEntries,
    remoteOpLabel
  };
}
