import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { SavedSession } from "@/sessions/lib/session";
import { useSftp } from "@/sftp/lib/useSftp";
import type {
  PaneEntry,
  PaneSide,
  TransferControlAction,
  TransferPolicy
} from "@/sftp/lib/useSftp";
import {
  findCollisions,
  hasResumable,
  pathsToTerminalText
} from "@/sftp/lib/sftpUtils";
import type { FileAction } from "@/sftp/components/FileContextMenu";
import SftpPanel from "@/sftp/components/SftpPanel";
import TransferPolicyDialog from "@/sftp/components/TransferPolicyDialog";

/** 等用户选策略的一次跨栏传输：冲突清单 + 选定后的执行动作。 */
type PendingTransfer = {
  conflicts: PaneEntry[];
  hasResume: boolean;
  run: (policy: TransferPolicy) => void;
};

type SftpWindowProps = {
  /** 这个窗口绑定的会话（决定 SFTP 连到哪台机器） */
  session: SavedSession;
  /** 错误提示出口（窗口内的提示条） */
  onError: (message: string) => void;
};

/**
 * 一个独立 SFTP 窗口的内容。
 *
 * 每个窗口自己持有一份 `useSftp` 状态（两侧目录、剪贴板、传输任务），
 * 因此开多个窗口互不干扰。窗口本身是后端建出来的系统窗口，所以这里
 * 不涉及开 / 关 / 最小化 —— 那些交给系统标题栏。
 */
export default function SftpWindow({
  session,
  onError
}: SftpWindowProps) {
  const sftp = useSftp(session);
  // 等用户选策略的传输：有同名冲突时才挂起
  const [pendingTransfer, setPendingTransfer] =
    useState<PendingTransfer | null>(null);

  /**
   * 计划一次跨栏传输：目标栏当前列表有同名项时先弹策略对话框，
   * 没有冲突直接按覆盖执行（= 旧行为）。
   *
   * `run` 由调用方闭包好"往哪传、传什么"，这里只负责拦与放。
   */
  const planCrossPane = useCallback(
    (
      from: PaneSide,
      entries: PaneEntry[],
      directory: string,
      run: (policy: TransferPolicy) => void
    ) => {
      const targetListing =
        from === "local"
          ? sftp.remote
          : sftp.local;
      const conflicts = targetListing
        ? findCollisions(
            entries,
            targetListing.entries
          )
        : [];
      if (!conflicts.length || !targetListing) {
        void run("overwrite");
        return;
      }
      setPendingTransfer({
        conflicts,
        hasResume: hasResumable(
          conflicts,
          targetListing.entries
        ),
        run
      });
    },
    [sftp.remote, sftp.local]
  );

  /** 远程导航：会话与路径一起交给 hook（它负责解密密码）。 */
  const handleNavigateRemote = useCallback(
    (path: string, refresh = false) => {
      if (sftp.session)
        void sftp.navigateRemote(
          sftp.session,
          path,
          refresh
        );
    },
    [sftp]
  );

  /** 强制重读两侧当前目录（远程会跳过后端目录缓存）。 */
  const handleRefreshLocal = useCallback(() => {
    void sftp.navigateLocal(sftp.local?.path);
  }, [sftp]);
  const handleRefreshRemote = useCallback(() => {
    if (sftp.remote)
      handleNavigateRemote(
        sftp.remote.path,
        true
      );
  }, [sftp.remote, handleNavigateRemote]);

  /** 右键菜单动作：转发给 useSftp，失败统一走提示条。
   *  entries 是本次作用的完整条目集（多选整批，单项时只含 entry）。 */
  const handleFileAction = useCallback(
    async (
      pane: PaneSide,
      action: FileAction,
      entry: PaneEntry | null,
      entries: PaneEntry[]
    ) => {
      try {
        switch (action) {
          case "open":
            if (entry)
              await sftp.openEntry(
                pane,
                entry,
                false
              );
            break;
          case "openNotepad":
            if (entry)
              await sftp.openEntry(
                pane,
                entry,
                true
              );
            break;
          case "copy":
            if (entries.length)
              sftp.copyToClipboard(pane, entries);
            break;
          case "paste":
            // 跨栏粘贴有同名冲突时也要过策略对话框；
            // 同栏本地复制不走这条（fs_copy_path 行为不变）
            if (
              sftp.clipboard &&
              sftp.clipboard.pane !== pane
            ) {
              const pasteTarget =
                sftp.clipboard.pane === "local"
                  ? sftp.remote
                  : sftp.local;
              const pasteConflicts = pasteTarget
                ? findCollisions(
                    sftp.clipboard.entries,
                    pasteTarget.entries
                  )
                : [];
              if (
                pasteConflicts.length &&
                pasteTarget
              ) {
                setPendingTransfer({
                  conflicts: pasteConflicts,
                  hasResume: hasResumable(
                    pasteConflicts,
                    pasteTarget.entries
                  ),
                  run: policy => {
                    void sftp
                      .pasteInto(pane, policy)
                      .catch(reason =>
                        onError(String(reason))
                      );
                  }
                });
                break;
              }
            }
            await sftp.pasteInto(pane);
            break;
          case "delete":
            // 二次确认已在 FilePane 的确认对话框里完成
            if (entries.length > 1) {
              await sftp.removeEntries(
                pane,
                entries
              );
            } else if (entry) {
              await sftp.removeEntry(pane, entry);
            }
            break;
          case "transfer":
            // 单项也走批量通道：目标目录与逐条任务逻辑同源
            if (entries.length) {
              const directory =
                pane === "local"
                  ? sftp.remote?.path
                  : sftp.local?.path;
              if (!directory) {
                throw new Error(
                  pane === "local"
                    ? "远程目录尚未加载，无法上传"
                    : "本地目录尚未加载，无法下载"
                );
              }
              planCrossPane(
                pane,
                entries,
                directory,
                policy => {
                  void sftp
                    .transferEntries(
                      pane,
                      entries,
                      directory,
                      policy
                    )
                    .catch(reason =>
                      onError(String(reason))
                    );
                }
              );
            }
            break;
        }
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError, planCrossPane]
  );

  /** 新建对话框确认：在当前目录下创建文件夹或空文件。 */
  const handleCreateEntry = useCallback(
    async (
      pane: PaneSide,
      isDir: boolean,
      name: string
    ) => {
      try {
        await sftp.createEntry(pane, isDir, name);
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError]
  );

  /** 权限修改确认（仅远程栏；多选整批生效）。 */
  const handleChmodEntry = useCallback(
    async (
      entries: PaneEntry[],
      mode: number
    ) => {
      try {
        await sftp.changeModes(entries, mode);
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError]
  );

  /** 重命名确认。 */
  const handleRenameEntry = useCallback(
    async (
      pane: PaneSide,
      entry: PaneEntry,
      name: string
    ) => {
      try {
        await sftp.renameEntry(pane, entry, name);
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError]
  );

  /** 传输任务控制：暂停 / 恢复 / 取消。 */
  const handleTransferControl = useCallback(
    async (
      id: string,
      action: TransferControlAction
    ) => {
      try {
        await sftp.controlTransfer(id, action);
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError]
  );

  /**
   * 拖出 SFTP 窗口边界松手：把路径文本广播给主窗口（拖路径进终端）。
   *
   * 绑定会话 id 一起带上 —— 主窗口按 id / sourceSessionId 解析出
   * 该会话自己的终端标签再写入，远程路径对别的会话没有意义。
   */
  const handlePathDrop = useCallback(
    (
      entries: PaneEntry[],
      screenX: number,
      screenY: number
    ) => {
      const current = sftp.session;
      if (!current || !entries.length) return;
      const text = pathsToTerminalText(entries);
      console.info(
        `[path-drop] drop outside, session=${current.id} text=${text}`
      );
      void invoke("debug_log", {
        message: `[path-drop] drop outside, session=${current.id} text=${text}`
      }).catch(() => {});
      void emit("sftp-paths-to-terminal", {
        sessionId: current.id,
        text,
        screenX,
        screenY
      });
    },
    [sftp.session]
  );

  /** 跨栏拖放落点：把条目传进目标目录（有同名冲突先弹策略框）。 */
  const handleDropEntries = useCallback(
    (
      from: PaneSide,
      entries: PaneEntry[],
      directory: string
    ) => {
      planCrossPane(
        from,
        entries,
        directory,
        policy => {
          void sftp
            .transferEntries(
              from,
              entries,
              directory,
              policy
            )
            .catch(reason =>
              onError(String(reason))
            );
        }
      );
    },
    [planCrossPane, sftp, onError]
  );

  return (
    <>
      <SftpPanel
        session={sftp.session}
        local={sftp.local}
        localError={sftp.localError}
        remote={sftp.remote}
        remoteError={sftp.remoteError}
        remoteBusy={sftp.remoteBusy}
        remoteUsage={sftp.remoteUsage}
        onNavigateLocal={sftp.navigateLocal}
        onNavigateRemote={handleNavigateRemote}
        onRefreshLocal={handleRefreshLocal}
        onRefreshRemote={handleRefreshRemote}
        canPaste={sftp.canPaste}
        onFileAction={handleFileAction}
        onCreateEntry={handleCreateEntry}
        onRenameEntry={handleRenameEntry}
        onChmodEntry={handleChmodEntry}
        transfers={sftp.transfers}
        onClearTransfers={sftp.clearTransfers}
        onRemoveTransfers={sftp.removeTransfer}
        onTransferControl={handleTransferControl}
        bookmarks={sftp.bookmarks}
        onToggleBookmark={sftp.toggleBookmark}
        onRemoveBookmark={sftp.removeBookmark}
        onPathDrop={handlePathDrop}
        onDropEntries={handleDropEntries}
      />
      {pendingTransfer && (
        <TransferPolicyDialog
          conflicts={pendingTransfer.conflicts}
          hasResume={pendingTransfer.hasResume}
          onDecide={policy => {
            const run = pendingTransfer.run;
            setPendingTransfer(null);
            run(policy);
          }}
          onClose={() => setPendingTransfer(null)}
        />
      )}
    </>
  );
}
