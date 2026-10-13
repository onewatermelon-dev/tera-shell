import {
  FileOutlined,
  FolderOutlined
} from "@ant-design/icons";
import type { PaneEntry } from "@/sftp/lib/useSftp";

/**
 * 列表项图标：优先用系统原生图标（后端从 Windows Shell 取到、以 PNG
 * data URL 传来），取不到时退回内置的线性图标，保证任何情况下都不会空白。
 */
export default function EntryIcon({
  entry,
  icons
}: {
  entry: PaneEntry;
  icons?: Record<string, string>;
}) {
  const source = icons?.[entry.iconKey ?? ""];
  if (source) {
    return (
      <img
        className="file-icon"
        src={source}
        alt=""
      />
    );
  }
  return entry.isDir ? (
    <FolderOutlined />
  ) : (
    <FileOutlined />
  );
}
