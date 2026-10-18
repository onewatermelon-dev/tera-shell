/**
 * 文件列表的一行：图标 + 名称 + 大小 / 权限 / 所有者 / 修改时间。
 *
 * 从 FilePane.tsx 拆出（2026-10-13）。纯展示 —— 按下、双击、右键的
 * 语义（选中 / 进入 / 弹菜单）都由父级接线，这里只负责把状态画出来。
 */
import { FolderOutlined } from "@ant-design/icons";
import type { PaneEntry } from "@/sftp/lib/useSftp";
import {
  formatPerm,
  formatSize,
  formatTime
} from "@/sftp/lib/fileFormat";
import EntryIcon from "./EntryIcon";

export function FileRow({
  entry,
  gridClass,
  selected,
  dragging,
  dropTarget,
  isLocal,
  icons,
  onPointerDown,
  onDoubleClick,
  onContextMenu
}: {
  entry: PaneEntry;
  /** 列结构类（本地 / 远程两套） */
  gridClass: string;
  selected: boolean;
  /** 正被拖走（压暗，让用户看清从哪儿来） */
  dragging?: boolean;
  /** 当前落点（目录高亮成"放这里"） */
  dropTarget?: boolean;
  isLocal: boolean;
  /** 本次列表用到的系统图标（iconKey → PNG data URL） */
  icons?: Record<string, string>;
  onPointerDown: (
    event: React.PointerEvent<HTMLElement>
  ) => void;
  onDoubleClick: () => void;
  onContextMenu: (
    event: React.MouseEvent
  ) => void;
}) {
  return (
    <div
      className={`file-row ${gridClass} ${
        selected ? "is-selected" : ""
      }`}
      // 落点判定只读这两个属性：路径用于配对，isDir 决定
      // "落进这个目录"还是"落到所在目录"。刻意不把整条
      // listing 塞进属性里 —— 大目录下那会撑爆 DOM。
      data-entry-path={entry.path}
      data-entry-dir={entry.isDir}
      data-dragging={dragging || undefined}
      data-drop-target={dropTarget || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span className="cell-name">
        <EntryIcon entry={entry} icons={icons} />
        <span className="file-name">
          {entry.name}
        </span>
      </span>
      <span className="cell-size">
        {entry.isDir
          ? ""
          : formatSize(entry.size)}
      </span>
      {!isLocal && (
        <span className="cell-perm">
          {formatPerm(entry)}
        </span>
      )}
      {!isLocal && (
        <span className="cell-owner">
          {entry.owner ?? "—"}
        </span>
      )}
      <span className="cell-time">
        {formatTime(entry.modified)}
      </span>
    </div>
  );
}

/** 列表顶部的「..」回上级行（与普通行同一套列结构）。 */
export function ParentRow({
  dirIcon,
  onOpenParent
}: {
  /** 后端给的目录图标（data URL）；没有就用内置图标 */
  dirIcon?: string;
  onOpenParent: () => void;
}) {
  return (
    <div
      className="file-row"
      onDoubleClick={onOpenParent}
    >
      <span className="cell-name">
        {dirIcon ? (
          <img
            className="file-icon"
            src={dirIcon}
            alt=""
          />
        ) : (
          <FolderOutlined />
        )}
        <span className="file-name">..</span>
      </span>
    </div>
  );
}
