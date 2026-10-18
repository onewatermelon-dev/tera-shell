import { useMemo } from "react";
import type { SavedSession } from "@/sessions/lib/session";
import { useTransferTasks } from "@/sftp/lib/useTransferTasks";
import { useSftpBookmarks } from "@/sftp/lib/useSftpBookmarks";
import { useSftpNavigation } from "@/sftp/lib/useSftpNavigation";
import { useSftpTransfers } from "@/sftp/lib/useSftpTransfers";
import { useSftpEntryOps } from "@/sftp/lib/useSftpEntryOps";
import { useSftpServerOps } from "@/sftp/lib/useSftpServerOps";
import { useSftpClipboard } from "@/sftp/lib/useSftpClipboard";
import { useSettings } from "@/settings/lib/useSettings";
import { useNotifications } from "@/lib/useNotifications";

// 类型定义集中在 sftpUtils，这里重新导出，外部仍从 useSftp 引入
export type {
  PaneEntry,
  PaneListing,
  PaneSide,
  RemoteDiskUsage,
  TransferControlAction,
  TransferDirection,
  TransferPolicy,
  TransferStatus,
  TransferTask
} from "@/sftp/lib/sftpUtils";

/**
 * SFTP 窗口的数据源（门面）。
 *
 * 按职责拆到几个 hook 里组合，外部仍只从这里引入：
 * - `useSftpBookmarks` 目录书签；
 * - `useSftpNavigation` 两侧目录的浏览状态与导航（含首屏加载）；
 * - `useSftpTransfers` 批量传输与传输任务控制；
 * - `useSftpEntryOps` 条目级操作（打开/新建/删除/重命名/改权限）；
 * - `useSftpServerOps` 服务端 cp/mv 与归档（含底部进度文案）；
 * - `useSftpClipboard` 内部剪贴板与粘贴分流。
 *
 * 本地目录走 `fs_list_dir`，远程目录走 `sftp_list`。首屏在打开动作用户点击时
 * 加载，之后的双击进入 / 上一级 / 右键菜单操作也都在事件回调里触发，
 * 所以组件内不需要用 effect 拉数据。
 */
export function useSftp(
  session: SavedSession | null = null
) {
  const {
    bookmarks,
    toggleBookmark,
    removeBookmark
  } = useSftpBookmarks();
  // 传输结束通知：SFTP 是**独立窗口**（label 为 sftp-*），拿不到主窗口
  // App 层的东西，所以这里自己取设置、自己接线 —— 顺带保证通知跟着
  // 这个窗口的焦点状态判定（用户正看着这个窗口时不该弹）
  const sftpSettings = useSettings();
  const notifications = useNotifications(
    sftpSettings.settings
  );
  // tasks 的 effect 要早于首屏加载的 effect（保持原 hook 内的顺序）
  const tasks = useTransferTasks(
    notifications.notifyTransferDone
  );
  const {
    local,
    localError,
    remote,
    remoteError,
    remoteBusy,
    remoteUsage,
    navigateLocal,
    navigateRemote,
    patchRemoteEntries
  } = useSftpNavigation(session);
  const {
    transferEntries,
    clearTransfers,
    removeTransfer,
    controlTransfer
  } = useSftpTransfers({
    session,
    local,
    remote,
    tasks,
    navigateLocal,
    navigateRemote
  });
  const {
    openEntry,
    createEntry,
    removeEntry,
    removeEntries,
    renameEntry,
    changeMode,
    changeModes
  } = useSftpEntryOps({
    session,
    local,
    remote,
    tasks,
    navigateLocal,
    navigateRemote
  });
  const {
    remoteFileOp,
    archiveEntries,
    remoteOpLabel
  } = useSftpServerOps({
    session,
    remote,
    patchRemoteEntries,
    navigateRemote
  });
  const {
    clipboard,
    copyToClipboard,
    pasteInto
  } = useSftpClipboard({
    local,
    remote,
    navigateLocal,
    transferEntries,
    remoteFileOp
  });

  // 返回值做 memo：调用方可以安全地把它整体放进 useCallback 依赖，
  // 也不会因为每次渲染新建对象而打穿下层组件的 memo。
  return useMemo(
    () => ({
      session,
      local,
      localError,
      remote,
      remoteError,
      remoteBusy,
      /** 远程磁盘用量（状态条展示）；未加载或查询失败为 null */
      remoteUsage,
      canPaste: clipboard !== null,
      /** 内部剪贴板（跨栏粘贴的冲突检测要用来源条目清单） */
      clipboard,
      transfers: tasks.transfers,
      navigateLocal,
      navigateRemote,
      openEntry,
      transferEntries,
      createEntry,
      removeEntry,
      removeEntries,
      renameEntry,
      changeMode,
      changeModes,
      copyToClipboard,
      pasteInto,
      clearTransfers,
      removeTransfer,
      controlTransfer,
      bookmarks,
      toggleBookmark,
      removeBookmark,
      archiveEntries,
      remoteFileOp,
      remoteOpLabel
    }),
    [
      session,
      local,
      localError,
      remote,
      remoteError,
      remoteBusy,
      remoteUsage,
      clipboard,
      tasks,
      navigateLocal,
      navigateRemote,
      openEntry,
      transferEntries,
      createEntry,
      removeEntry,
      removeEntries,
      renameEntry,
      changeMode,
      changeModes,
      copyToClipboard,
      pasteInto,
      clearTransfers,
      removeTransfer,
      controlTransfer,
      bookmarks,
      toggleBookmark,
      removeBookmark,
      archiveEntries,
      remoteFileOp,
      remoteOpLabel
    ]
  );
}
