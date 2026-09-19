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
    entry: PaneEntry | null
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
    entry: PaneEntry,
    mode: number
  ) => void;
  transfers: TransferTask[];
  onClearTransfers: () => void;
  onTransferControl: (
    id: string,
    action: TransferControlAction
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
  onTransferControl
}: SftpPanelProps) {
  // 标题栏文案：与会话名一致（后端建窗口时的标题用的是同一个名字）
  const title = `SFTP · ${session?.name ?? "会话"}`;
  // 远程栏标题：主机 IP 直接写在"远程"旁边
  const remoteLabel =
    session?.kind === "ssh"
      ? `远程 · ${session.host}`
      : "远程";

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
            onContextAction={(action, entry) =>
              onFileAction("local", action, entry)
            }
            onCreate={(isDir, name) =>
              onCreateEntry("local", isDir, name)
            }
            onRename={(entry, name) =>
              onRenameEntry("local", entry, name)
            }
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
            onContextAction={(action, entry) =>
              onFileAction(
                "remote",
                action,
                entry
              )
            }
            onCreate={(isDir, name) =>
              onCreateEntry("remote", isDir, name)
            }
            onRename={(entry, name) =>
              onRenameEntry("remote", entry, name)
            }
            onChmod={(entry, mode) =>
              onChmodEntry(entry, mode)
            }
          />
        </div>
        <TransferPanel
          tasks={transfers}
          onClear={onClearTransfers}
          onControl={onTransferControl}
        />
      </div>
    </div>
  );
}
