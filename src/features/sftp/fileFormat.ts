import type { PaneEntry } from "@/features/sftp/useSftp";

/** 把字节数格式化成便于阅读的容量文本。 */
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 把 Unix 秒格式化成 `MM-DD HH:mm`；取不到时间时显示占位符。 */
export function formatTime(
  seconds?: number | null
): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value: number) =>
    String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把 Unix 权限位格式化成 `drwxr-xr-x`。
 *
 * `perm` 是含文件类型位的 st_mode（如 0o100644）；Windows 本地文件没有
 * Unix 权限，此时显示占位符。
 */
export function formatPerm(
  entry: PaneEntry
): string {
  if (entry.perm == null) return "—";
  const masks: Array<[number, string]> = [
    [0o400, "r"],
    [0o200, "w"],
    [0o100, "x"],
    [0o040, "r"],
    [0o020, "w"],
    [0o010, "x"],
    [0o004, "r"],
    [0o002, "w"],
    [0o001, "x"]
  ];
  let text = entry.isDir ? "d" : "-";
  for (const [mask, char] of masks) {
    text += entry.perm & mask ? char : "-";
  }
  return text;
}
