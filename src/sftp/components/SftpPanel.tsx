import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined
} from "@ant-design/icons";
import { Button } from "@heroui/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SavedSession } from "@/sessions/lib/session";
import type {
  PaneEntry,
  PaneListing,
  PaneSide,
  TransferControlAction,
  TransferTask
} from "@/sftp/lib/useSftp";
import type { FileAction } from "@/sftp/components/FileContextMenu";
import FilePane from "@/sftp/components/FilePane";
import TransferPanel from "@/sftp/components/TransferPanel";
import { usePaneDrag } from "@/sftp/lib/usePaneDrag";
import type { DropTarget } from "@/sftp/lib/dragTransfer";

type SftpPanelProps = {
  /** 决定远程栏标题与是否连 SFTP（本机终端没有远程目录） */
  session: SavedSession | null;
  local: PaneListing | null;
  localError: string;
  remote: PaneListing | null;
  remoteError: string;
  remoteBusy: boolean;
  onNavigateLocal: (path: string) => void;
  onNavigateRemote: (path: string) => void;
  onRefreshLocal: () => void;
  onRefreshRemote: () => void;
  canPaste: boolean;
  onFileAction: (
    pane: PaneSide,
    action: FileAction,
    entry: PaneEntry | null,
    entries: PaneEntry[]
  ) => void;
  onCreateEntry: (
    pane: PaneSide,
    isDir: boolean,
    name: string
  ) => void;
  onRenameEntry: (
    pane: PaneSide,
    entry: PaneEntry,
    name: string
  ) => void;
  onChmodEntry: (
    entries: PaneEntry[],
    mode: number
  ) => void;
  transfers: TransferTask[];
  onClearTransfers: () => void;
  /** 删除单条已结束的传输记录 */
  onRemoveTransfers: (id: string) => void;
  onTransferControl: (
    id: string,
    action: TransferControlAction
  ) => void;
  /**
   * 拖拽落点确认：把条目从来源栏传进目标栏的该目录。
   *
   * 拖拽控制器放在本组件内部（两个消费方 —— 独立窗口与嵌入面板 —— 都白拿），
   * 消费方只需要实现"怎么传"这一件事。
   */
  onDropEntries: (
    from: PaneSide,
    entries: PaneEntry[],
    directory: string
  ) => void;
};

/**
 * 独立窗口的窗口控制：本窗口没有系统标题栏（decorations: false），
 * 最小化 / 最大化 / 关闭都要自己实现。
 */
const currentWindow = getCurrentWindow();

/**
 * SFTP 的主体内容：自绘标题栏 + 左右两栏 + 底部传输面板。
 *
 * 刻意**不带任何窗口外壳逻辑** —— 独立窗口（SftpApp）直接把它铺满自己的
 * 客户区，所以这里用普通块级布局而非 Modal，窗口缩放时自然自适应。
 */
export default function SftpPanel({
  session,
  local,
  localError,
  remote,
  remoteError,
  remoteBusy,
  onNavigateLocal,
  onNavigateRemote,
  onRefreshLocal,
  onRefreshRemote,
  canPaste,
  onFileAction,
  onCreateEntry,
  onRenameEntry,
  onChmodEntry,
  transfers,
  onClearTransfers,
  onRemoveTransfers,
  onTransferControl,
  onDropEntries
}: SftpPanelProps) {
  // 标题栏文案：与会话名一致（后端建窗口时的标题用的是同一个名字）
  const title = `SFTP · ${session?.name ?? "会话"}`;
  // 远程栏标题：主机 IP 直接写在"远程"旁边
  const remoteLabel =
    session?.kind === "ssh"
      ? `远程 · ${session.host}`
      : "远程";

  // 跨栏拖拽：松手时把来源栏的条目传进目标栏目录。
  // 单一回调入口，两个 FilePane 共用同一套拖拽状态 ——
  // 「谁在被拖」和「哪栏是落点」天然跨栏共享。
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

  return (
    <div className="sftp-panel">
      {/* 自绘标题栏：无系统装饰，这一条同时充当窗口拖动区 */}
      <header
        className="sftp-titlebar"
        data-tauri-drag-region
      >
        <span
          className="sftp-titlebar-text"
          data-tauri-drag-region
        >
          {title}
        </span>
        <div className="win-controls">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="最小化"
            onPress={() =>
              void currentWindow.minimize()
            }
          >
            <MinusOutlined />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="最大化"
            onPress={() =>
              void currentWindow.toggleMaximize()
            }
          >
            <BorderOutlined />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            className="win-close"
            aria-label="关闭"
            onPress={() =>
              void currentWindow.close()
            }
          >
            <CloseOutlined />
          </Button>
        </div>
      </header>
      <div className="sftp-content">
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
              onCreateEntry("local", isDir, name)
            }
            onRename={(entry, name) =>
              onRenameEntry("local", entry, name)
            }
            side="local"
            onDragStart={startDrag}
            isDragging={isDragging}
            isTarget={isTarget}
            isPaneTarget={isPaneTarget("local")}
          />
          <FilePane
            label={remoteLabel}
            listing={remote}
            error={remoteError}
            busy={remoteBusy}
            emptyText={
              session?.kind === "ssh"
                ? "空文件夹"
                : "当前是本机终端，没有远程目录"
            }
            onOpen={onNavigateRemote}
            onRefresh={onRefreshRemote}
            isLocal={false}
            canPaste={canPaste}
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
              onCreateEntry("remote", isDir, name)
            }
            onRename={(entry, name) =>
              onRenameEntry("remote", entry, name)
            }
            onChmod={(entries, mode) =>
              onChmodEntry(entries, mode)
            }
            side="remote"
            onDragStart={startDrag}
            isDragging={isDragging}
            isTarget={isTarget}
            isPaneTarget={isPaneTarget("remote")}
          />
        </div>
        <TransferPanel
          tasks={transfers}
          onClear={onClearTransfers}
          onRemove={onRemoveTransfers}
          onControl={onTransferControl}
        />
      </div>
    </div>
  );
}
