import { useState } from "react";
import {
  ArrowLeftOutlined,
  BorderOutlined,
  CloseOutlined,
  MinusOutlined
} from "@ant-design/icons";
import { Button, Modal } from "@heroui/react";
import type { SavedSession } from "@/sessions/lib/session";
import type {
  PaneEntry,
  PaneListing,
  PaneSide,
  RemoteDiskUsage,
  TransferControlAction,
  TransferTask
} from "@/sftp/lib/useSftp";
import { formatSize } from "@/sftp/lib/fileFormat";
import type { FileAction } from "@/sftp/components/FileContextMenu";
import FilePane from "@/sftp/components/FilePane";
import SftpDock from "@/sftp/components/SftpDock";
import TransferPanel from "@/sftp/components/TransferPanel";
import { usePaneDrag } from "@/sftp/lib/usePaneDrag";
import {
  bookmarkPathsFor,
  type SftpBookmark
} from "@/sftp/lib/sftpBookmarks";
import type { DropTarget } from "@/sftp/lib/dragTransfer";

type Props = {
  /** 当前活动会话：由 App 从终端状态里取，用于确定 SFTP 的连接目标。 */
  session?: SavedSession | null;
  /** 窗口序号（从 1 开始）：同时开多个时才显示，用来区分 */
  index?: number;
  local: PaneListing | null;
  localError: string;
  remote: PaneListing | null;
  remoteError: string;
  remoteBusy: boolean;
  /** 远程磁盘用量（状态条展示）；未加载或查询失败为 null。 */
  remoteUsage: RemoteDiskUsage | null;
  onNavigateLocal: (path: string) => void;
  onNavigateRemote: (path: string) => void;
  onRefreshLocal: () => void;
  onRefreshRemote: () => void;
  /** 最小化：收起窗口但保留会话，下次打开原样恢复 */
  onMinimize: () => void;
  onClose: () => void;
  /** 剪贴板里是否有可粘贴的内容 */
  canPaste: boolean;
  /** 目录书签（全部；本地栏按空 host 过滤，远程栏按会话主机过滤）。 */
  bookmarks: SftpBookmark[];
  /** 收藏 / 取消收藏某个目录。 */
  onToggleBookmark: (
    side: PaneSide,
    host: string,
    path: string
  ) => void;
  /** 删除一条书签。 */
  onRemoveBookmark: (
    side: PaneSide,
    host: string,
    path: string
  ) => void;
  /** 右键菜单动作；pane 指明发生在哪一栏，entries 为完整作用条目集 */
  onFileAction: (
    pane: PaneSide,
    action: FileAction,
    entry: PaneEntry | null,
    entries: PaneEntry[]
  ) => void;
  /** 新建文件夹 / 文件（对话框确认后触发） */
  onCreateEntry: (
    pane: PaneSide,
    isDir: boolean,
    name: string
  ) => void;
  /** 重命名确认（pane 指明发生在哪一栏） */
  onRenameEntry: (
    pane: PaneSide,
    entry: PaneEntry,
    name: string
  ) => void;
  /** 权限修改确认（仅远程栏；多选整批生效） */
  onChmodEntry: (
    entries: PaneEntry[],
    mode: number
  ) => void;
  /** 传输任务（底部面板展示） */
  transfers: TransferTask[];
  /** 清空已结束的传输记录 */
  onClearTransfers: () => void;
  /** 删除单条已结束的传输记录 */
  onRemoveTransfers: (id: string) => void;
  /** 暂停 / 恢复 / 取消传输任务 */
  onTransferControl: (
    id: string,
    action: TransferControlAction
  ) => void;
  /** 跨栏拖放落点：把条目从来源栏传进目标栏的该目录 */
  onDropEntries: (
    from: PaneSide,
    entries: PaneEntry[],
    directory: string
  ) => void;
  /** 全部打开的 SFTP 窗口（底部标签栏用；只有一个窗口时不显示） */
  windowTabs?: { id: string; label: string }[];
  /** 当前前台窗口 id */
  activeWindowId?: string | null;
  /** 切换到某个窗口 */
  onSelectWindow?: (id: string) => void;
  /** 关闭某个窗口（含本窗口） */
  onCloseWindow?: (id: string) => void;
};

/**
 * SFTP 文件传输窗口：左侧本机目录、右侧远程目录的双栏布局。
 *
 * 数据全部由外部（useSftp）持有并加载，本组件只负责装配骨架与派发操作，
 * 两侧列表的实际渲染在 `FilePane` 里，因此这里没有 effect 内的 setState。
 * 与 PasswordDialog 一致：父级条件渲染，`isOpen` 恒真、关闭回调父级卸载。
 */
export default function SftpDialog({
  session,
  index,
  local,
  localError,
  remote,
  remoteError,
  remoteBusy,
  remoteUsage,
  onNavigateLocal,
  onNavigateRemote,
  onRefreshLocal,
  onRefreshRemote,
  canPaste,
  bookmarks,
  onToggleBookmark,
  onRemoveBookmark,
  onFileAction,
  onCreateEntry,
  onRenameEntry,
  onChmodEntry,
  transfers,
  onClearTransfers,
  onRemoveTransfers,
  onTransferControl,
  onDropEntries,
  windowTabs,
  activeWindowId,
  onSelectWindow,
  onCloseWindow,
  onMinimize,
  onClose
}: Props) {
  // 窗口是否铺满：默认**不铺满**，让下面的终端照常可见可操作
  const [maximized, setMaximized] =
    useState(false);

  // 跨栏拖拽。⚠️ hook 必须写在下面的 `if (!session) return null` **之前** ——
  // 条件渲染会让 hook 数量变化，React 直接报「Rendered fewer hooks」。
  const {
    startDrag,
    isDragging,
    isTarget,
    isPaneTarget
  } = usePaneDrag({
    onDrop: (payload, target: DropTarget) =>
      onDropEntries(
        payload.from,
        payload.entries,
        target.intoDirectory
      )
  });

  // 兜底：父级条件渲染已保证有会话，HMR 或异常时序下仍可能短暂为空值
  if (!session) return null;

  // 远程栏标题：主机 IP 直接写在"远程"旁边，不再单列一行连接信息
  const remoteLabel =
    session.kind === "ssh"
      ? `远程 · ${session.host}`
      : "远程";
  // 书签按栏过滤：本地栏 host 恒空串；远程栏跟会话主机走
  const remoteHost =
    session.kind === "ssh" ? session.host : "";
  const localBookmarks = bookmarkPathsFor(
    bookmarks,
    "local",
    ""
  );
  const remoteBookmarks = bookmarkPathsFor(
    bookmarks,
    "remote",
    remoteHost
  );

  /**
   * 磁盘用量摘要，显示在远程栏标题旁：`可用 X / 共 Y · 目录 Z`。
   * 无数据（未加载 / 查询失败）返回 null，标题旁就不显示。
   */
  function formatUsage(
    usage: RemoteDiskUsage | null
  ): string | null {
    if (!usage) return null;
    const parts = [
      `可用 ${formatSize(usage.freeBytes)} / 共 ${formatSize(usage.totalBytes)}`
    ];
    if (usage.dirBytes > 0) {
      parts.push(
        `目录 ${formatSize(usage.dirBytes)}`
      );
    }
    return parts.join(" · ");
  }

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      {/* 遮罩透明且不接收事件：SFTP 窗口浮在终端上，终端仍可用 */}
      <Modal.Backdrop className="sftp-backdrop">
        {/* 非铺满时用自定义宽高（HeroUI 没有"占大半屏"这一档）；
            铺满用 size="full"，比自定义更稳，也不会被 modal 的 max-w 限制 */}
        <Modal.Container
          placement="center"
          size={maximized ? "full" : "lg"}
          className={
            maximized
              ? "sftp-container--full"
              : undefined
          }
        >
          <Modal.Dialog
            className={
              maximized
                ? "sftp-dialog"
                : "sftp-dialog sftp-dialog--floating"
            }
          >
            {/* 顶部兼作窗口拖动区：面板铺满后原标题栏被盖住，
                这里是唯一能拖动主窗口的地方（子元素穿透见 .sftp-header） */}
            <Modal.Header
              className="sftp-header"
              data-tauri-drag-region
            >
              {/* 左上角：回到终端工作区（收起窗口但保留会话，可从菜单恢复） */}
              <div className="sftp-back">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="返回工作区"
                  onPress={onMinimize}
                >
                  <ArrowLeftOutlined />
                  <span>返回工作区</span>
                </Button>
                {/* 同时开多个窗口时（都是全屏叠加、长得一样），靠这个序号区分 */}
                {index !== undefined && (
                  <span className="sftp-window-index">
                    窗口 #{index}
                  </span>
                )}
              </div>
              <div className="win-controls">
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label="最小化"
                  onPress={onMinimize}
                >
                  <MinusOutlined />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={
                    maximized ? "还原" : "最大化"
                  }
                  onPress={() =>
                    setMaximized(value => !value)
                  }
                >
                  <BorderOutlined />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label="关闭"
                  className="win-close"
                  onPress={onClose}
                >
                  <CloseOutlined />
                </Button>
              </div>
            </Modal.Header>
            <Modal.Body className="sftp-body">
              <div className="sftp-panes">
                <FilePane
                  label="本地"
                  listing={local}
                  error={localError}
                  busy={false}
                  emptyText="空文件夹"
                  onOpen={onNavigateLocal}
                  onRefresh={onRefreshLocal}
                  canPickPath
                  isLocal
                  canPaste={canPaste}
                  bookmarks={localBookmarks}
                  bookmarked={localBookmarks.includes(
                    local?.path ?? ""
                  )}
                  onToggleBookmark={() =>
                    onToggleBookmark(
                      "local",
                      "",
                      local?.path ?? ""
                    )
                  }
                  onRemoveBookmark={path =>
                    onRemoveBookmark(
                      "local",
                      "",
                      path
                    )
                  }
                  onContextAction={(
                    action,
                    entry,
                    entries
                  ) =>
                    onFileAction(
                      "local",
                      action,
                      entry,
                      entries
                    )
                  }
                  onCreate={(isDir, name) =>
                    onCreateEntry(
                      "local",
                      isDir,
                      name
                    )
                  }
                  onRename={(entry, name) =>
                    onRenameEntry(
                      "local",
                      entry,
                      name
                    )
                  }
                  side="local"
                  onDragStart={startDrag}
                  isDragging={isDragging}
                  isTarget={isTarget}
                  isPaneTarget={isPaneTarget(
                    "local"
                  )}
                />
                <FilePane
                  label={remoteLabel}
                  listing={remote}
                  error={remoteError}
                  busy={remoteBusy}
                  emptyText={
                    session.kind === "ssh"
                      ? "空文件夹"
                      : "当前是本机终端，没有远程目录"
                  }
                  onOpen={onNavigateRemote}
                  onRefresh={onRefreshRemote}
                  isLocal={false}
                  canPaste={canPaste}
                  bookmarks={remoteBookmarks}
                  bookmarked={remoteBookmarks.includes(
                    remote?.path ?? ""
                  )}
                  onToggleBookmark={() =>
                    onToggleBookmark(
                      "remote",
                      remoteHost,
                      remote?.path ?? ""
                    )
                  }
                  onRemoveBookmark={path =>
                    onRemoveBookmark(
                      "remote",
                      remoteHost,
                      path
                    )
                  }
                  onContextAction={(
                    action,
                    entry,
                    entries
                  ) =>
                    onFileAction(
                      "remote",
                      action,
                      entry,
                      entries
                    )
                  }
                  onCreate={(isDir, name) =>
                    onCreateEntry(
                      "remote",
                      isDir,
                      name
                    )
                  }
                  onRename={(entry, name) =>
                    onRenameEntry(
                      "remote",
                      entry,
                      name
                    )
                  }
                  onChmod={(entries, mode) =>
                    onChmodEntry(entries, mode)
                  }
                  side="remote"
                  onDragStart={startDrag}
                  isDragging={isDragging}
                  isTarget={isTarget}
                  isPaneTarget={isPaneTarget(
                    "remote"
                  )}
                  usageText={formatUsage(
                    remoteUsage
                  )}
                />
              </div>
              <TransferPanel
                tasks={transfers}
                onClear={onClearTransfers}
                onRemove={onRemoveTransfers}
                onControl={onTransferControl}
              />
            </Modal.Body>
            {windowTabs &&
              onSelectWindow &&
              onCloseWindow && (
                <SftpDock
                  windows={windowTabs}
                  activeId={
                    activeWindowId ?? null
                  }
                  onSelect={onSelectWindow}
                  onCloseWindow={onCloseWindow}
                />
              )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
