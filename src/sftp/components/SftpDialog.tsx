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
  TransferControlAction,
  TransferTask
} from "@/sftp/lib/useSftp";
import type { FileAction } from "@/sftp/components/FileContextMenu";
import FilePane from "@/sftp/components/FilePane";
import SftpDock from "@/sftp/components/SftpDock";
import TransferPanel from "@/sftp/components/TransferPanel";

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
  onNavigateLocal: (path: string) => void;
  onNavigateRemote: (path: string) => void;
  onRefreshLocal: () => void;
  onRefreshRemote: () => void;
  /** 最小化：收起窗口但保留会话，下次打开原样恢复 */
  onMinimize: () => void;
  onClose: () => void;
  /** 剪贴板里是否有可粘贴的内容 */
  canPaste: boolean;
  /** 右键菜单动作；pane 指明发生在哪一栏 */
  onFileAction: (
    pane: PaneSide,
    action: FileAction,
    entry: PaneEntry | null
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
  /** 权限修改确认（仅远程栏） */
  onChmodEntry: (
    entry: PaneEntry,
    mode: number
  ) => void;
  /** 传输任务（底部面板展示） */
  transfers: TransferTask[];
  /** 清空已结束的传输记录 */
  onClearTransfers: () => void;
  /** 暂停 / 恢复 / 取消传输任务 */
  onTransferControl: (
    id: string,
    action: TransferControlAction
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
  onTransferControl,
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

  // 兜底：父级条件渲染已保证有会话，HMR 或异常时序下仍可能短暂为空值
  if (!session) return null;

  // 远程栏标题：主机 IP 直接写在"远程"旁边，不再单列一行连接信息
  const remoteLabel =
    session.kind === "ssh"
      ? `远程 · ${session.host}`
      : "远程";

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
                  onContextAction={(
                    action,
                    entry
                  ) =>
                    onFileAction(
                      "local",
                      action,
                      entry
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
                  onContextAction={(
                    action,
                    entry
                  ) =>
                    onFileAction(
                      "remote",
                      action,
                      entry
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
