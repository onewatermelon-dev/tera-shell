import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type PaneEntry,
  type PaneListing,
  type PaneSide,
  type TransferPolicy
} from "@/sftp/lib/sftpUtils";

/**
 * 复制 / 粘贴用的内部剪贴板（记来源栏与一批条目，粘贴时才真正执行）。
 *
 * 粘贴的分流：同栏本地走 `fs_copy_path`、同栏远程走服务端 `cp -a`
 * （数据不过本机），跨栏走批量传输（自带逐条任务与刷新）。
 */
export function useSftpClipboard({
  local,
  remote,
  navigateLocal,
  transferEntries,
  remoteFileOp
}: {
  local: PaneListing | null;
  remote: PaneListing | null;
  navigateLocal: (
    path?: string | null
  ) => Promise<void>;
  transferEntries: (
    from: PaneSide,
    entries: PaneEntry[],
    directory: string,
    policy?: TransferPolicy
  ) => Promise<void>;
  remoteFileOp: (
    mode: "copy" | "move",
    entries: PaneEntry[],
    targetDir: string
  ) => Promise<void>;
}) {
  const [clipboard, setClipboard] = useState<{
    pane: PaneSide;
    entries: PaneEntry[];
  } | null>(null);

  /** 复制：只记入内部剪贴板（多选整批），粘贴时才真正执行。 */
  const copyToClipboard = useCallback(
    (pane: PaneSide, entries: PaneEntry[]) => {
      setClipboard(
        entries.length ? { pane, entries } : null
      );
    },
    []
  );

  /** 粘贴：同栏走本地复制 / 服务端 cp，跨栏走批量传输。 */
  const pasteInto = useCallback(
    async (
      pane: PaneSide,
      policy: TransferPolicy = "overwrite"
    ) => {
      if (!clipboard?.entries.length) return;
      if (clipboard.pane === pane) {
        if (pane === "remote") {
          // 远程 → 远程：服务端 cp -a，数据不过本机
          const directory = remote?.path;
          if (!directory) {
            throw new Error("远程目录尚未加载");
          }
          await remoteFileOp(
            "copy",
            clipboard.entries,
            directory
          );
          return;
        }
        const directory = local?.path;
        if (!directory) {
          throw new Error("本地目录尚未加载");
        }
        for (const entry of clipboard.entries) {
          await invoke("fs_copy_path", {
            from: entry.path,
            to: directory
          });
        }
        void navigateLocal(directory);
        return;
      }
      // 跨栏粘贴 = 上传 / 下载（transferEntries 自带逐条任务与刷新）
      const directory =
        clipboard.pane === "local"
          ? remote?.path
          : local?.path;
      if (!directory) {
        throw new Error("目标目录尚未加载");
      }
      await transferEntries(
        clipboard.pane,
        clipboard.entries,
        directory,
        policy
      );
    },
    [
      clipboard,
      local?.path,
      remote?.path,
      navigateLocal,
      remoteFileOp,
      transferEntries
    ]
  );

  return {
    clipboard,
    copyToClipboard,
    pasteInto
  };
}
