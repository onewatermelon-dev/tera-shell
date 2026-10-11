import { useEffect, useState } from "react";
import type { PaneEntry } from "@/sftp/lib/useSftp";
import { isArchiveName } from "@/sftp/lib/sftpUtils";

/** 菜单与视口边缘之间保留的间隙。 */
const VIEWPORT_MARGIN = 8;

/** 右键菜单可执行的操作。 */
export type FileAction =
  | "transfer"
  | "open"
  | "openNotepad"
  | "copy"
  | "paste"
  | "chmod"
  | "rename"
  | "create"
  | "compress"
  | "extract"
  | "delete";

type FileContextMenuProps = {
  /** 菜单左上角坐标（视口坐标，用 fixed 定位） */
  x: number;
  y: number;
  /** 右键点中的条目；空白处右键为 null */
  entry: PaneEntry | null;
  /** 本次菜单作用的条目数：右键落在选中集合里时等于选中数，否则 1 */
  count?: number;
  /** 是否本地栏：用关联程序 / 记事本打开只对本地文件有效 */
  isLocal: boolean;
  /** 剪贴板里是否有可粘贴的内容 */
  canPaste: boolean;
  onAction: (action: FileAction) => void;
  onClose: () => void;
};

/**
 * 文件列表的右键菜单。
 *
 * 菜单项固定为：传输 / 打开 / 用记事本打开 / 复制 / 粘贴 / 新建 / 删除，
 * 组之间用分隔符隔开。不可用的项直接禁用（例如远程文件无法用本地程序打开）。
 */
export default function FileContextMenu({
  x,
  y,
  entry,
  count = 1,
  isLocal,
  canPaste,
  onAction,
  onClose
}: FileContextMenuProps) {
  // 位置修正：鼠标贴近视口底部/右侧时菜单会被裁掉，量一次实际尺寸后平移回来。
  // 在 ref 回调里测量（DOM 已挂载），不需要 effect，也不会每次都调整。
  const [shift, setShift] = useState({
    x: 0,
    y: 0
  });
  const shifted = shift.x !== 0 || shift.y !== 0;

  function measure(node: HTMLDivElement | null) {
    if (!node || shifted) return;
    const rect = node.getBoundingClientRect();
    const overflowX =
      rect.right - window.innerWidth;
    const overflowY =
      rect.bottom - window.innerHeight;
    if (overflowX <= 0 && overflowY <= 0) return;
    setShift({
      // 同时保证修正后不会跑到视口左上角外面
      x:
        overflowX > 0
          ? -Math.min(
              overflowX + VIEWPORT_MARGIN,
              x - VIEWPORT_MARGIN
            )
          : 0,
      y:
        overflowY > 0
          ? -Math.min(
              overflowY + VIEWPORT_MARGIN,
              y - VIEWPORT_MARGIN
            )
          : 0
    });
  }

  // 点击菜单外或按 Esc 关闭
  useEffect(() => {
    const handlePointerDown = (
      event: MouseEvent
    ) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".file-context-menu")) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener(
      "mousedown",
      handlePointerDown
    );
    document.addEventListener(
      "keydown",
      handleKey
    );
    return () => {
      document.removeEventListener(
        "mousedown",
        handlePointerDown
      );
      document.removeEventListener(
        "keydown",
        handleKey
      );
    };
  }, [onClose]);

  /** 当前上下文下该操作是否可用。 */
  function isDisabled(
    action: FileAction
  ): boolean {
    // 多选时只保留批量有意义的操作：打开 / 重命名只对单条有效
    const single = entry && count <= 1;
    switch (action) {
      // 目录也能传（后端递归处理）
      case "transfer":
        return !entry;
      // 远程文件会先拉到临时目录再打开；远程目录没法整体落地，故禁用
      case "open":
        return (
          !single || (!isLocal && entry.isDir)
        );
      // 记事本只用来看文件内容
      case "openNotepad":
        return !single || entry.isDir;
      case "copy":
        return !entry;
      case "paste":
        return !canPaste;
      // 权限是 Unix 概念，只在远程栏出现
      case "chmod":
        return !entry;
      case "rename":
        return !single;
      // 新建不需要选中条目，删到当前目录下即可
      case "create":
        return false;
      // 远程归档：压缩对单选 / 多选都可用，解压只对压缩包文件有效
      case "compress":
        return !entry;
      case "extract":
        return !(
          entry &&
          count <= 1 &&
          isArchiveName(entry.name)
        );
      case "delete":
        return !entry;
    }
  }

  function renderItem(
    action: FileAction,
    label: string,
    strong = false
  ) {
    return (
      <button
        type="button"
        className={
          strong
            ? "context-menu-item context-menu-item--strong"
            : "context-menu-item"
        }
        disabled={isDisabled(action)}
        onClick={() => {
          onAction(action);
          onClose();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      ref={measure}
      className="file-context-menu"
      style={{
        left: x,
        top: y,
        transform: `translate(${shift.x}px, ${shift.y}px)`
      }}
    >
      {renderItem("transfer", "传输", true)}
      <div className="context-menu-separator" />
      {renderItem("open", "打开")}
      {renderItem("openNotepad", "用记事本打开")}
      <div className="context-menu-separator" />
      {renderItem("copy", "复制")}
      {renderItem("paste", "粘贴")}
      {/* 权限是 Unix 概念，只在远程栏出现 */}
      {!isLocal &&
        renderItem("chmod", "权限修改")}
      <div className="context-menu-separator" />
      {renderItem(
        "rename",
        entry?.isDir ? "重命名文件夹" : "重命名"
      )}
      {renderItem("create", "新建")}
      {/* 远程归档是 shell 操作（tar / unzip），本地栏不提供 */}
      {!isLocal && (
        <>
          <div className="context-menu-separator" />
          {renderItem(
            "compress",
            "压缩为 tar.gz"
          )}
          {renderItem(
            "extract",
            "解压到当前目录"
          )}
        </>
      )}
      <div className="context-menu-separator" />
      {renderItem("delete", "删除")}
    </div>
  );
}
