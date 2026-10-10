import { useCallback } from "react";
import type { SavedSession } from "@/sessions/lib/session";
import { useSftp } from "@/sftp/lib/useSftp";
import type {
  PaneEntry,
  PaneSide,
  TransferControlAction
} from "@/sftp/lib/useSftp";
import type { FileAction } from "@/sftp/components/FileContextMenu";
import SftpPanel from "@/sftp/components/SftpPanel";

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

  /** 右键菜单动作：转发给 useSftp，失败统一走提示条。 */
  const handleFileAction = useCallback(
    async (
      pane: PaneSide,
      action: FileAction,
      entry: PaneEntry | null
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
            if (entry)
              sftp.copyToClipboard(pane, entry);
            break;
          case "paste":
            await sftp.pasteInto(pane);
            break;
          case "delete":
            // 二次确认已在 FilePane 的确认对话框里完成
            if (entry)
              await sftp.removeEntry(pane, entry);
            break;
          case "transfer":
            if (entry)
              await sftp.transferFile(
                pane,
                entry
              );
            break;
        }
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError]
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

  /** 权限修改确认（仅远程栏）。 */
  const handleChmodEntry = useCallback(
    async (entry: PaneEntry, mode: number) => {
      try {
        await sftp.changeMode(entry, mode);
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

  /** 跨栏拖放落点：把条目传进目标目录。 */
  const handleDropEntries = useCallback(
    async (
      from: PaneSide,
      entries: PaneEntry[],
      directory: string
    ) => {
      try {
        await sftp.transferEntries(
          from,
          entries,
          directory
        );
      } catch (reason) {
        onError(String(reason));
      }
    },
    [sftp, onError]
  );

  return (
    <SftpPanel
      session={sftp.session}
      local={sftp.local}
      localError={sftp.localError}
      remote={sftp.remote}
      remoteError={sftp.remoteError}
      remoteBusy={sftp.remoteBusy}
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
      onDropEntries={handleDropEntries}
    />
  );
}
