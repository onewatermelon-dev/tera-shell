import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import type { PaneSide } from "@/sftp/lib/sftpUtils";

/**
 * SFTP 目录书签。
 *
 * 一条书签 = 侧栏（本地 / 远程）+ 主机 + 目录路径。本地书签对所有
 * 会话通用（host 为空串）；远程书签按主机隔离 —— 连不同服务器时
 * 各看各的收藏，不会把 A 机的路径跳到 B 机上去。
 *
 * 落盘到 `sftp_bookmarks.json`（DataName 白名单），内存先行、异步写盘。
 */
export type SftpBookmark = {
  side: PaneSide;
  /** 远程主机名；本地书签为空串 */
  host: string;
  path: string;
};

/** 读全部书签；文件不存在或内容损坏时按空表继续。 */
export function loadBookmarks(): SftpBookmark[] {
  const raw = readData(DataName.sftpBookmarks);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SftpBookmark =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SftpBookmark).path ===
          "string" &&
        ((item as SftpBookmark).side ===
          "local" ||
          (item as SftpBookmark).side ===
            "remote")
    );
  } catch {
    return [];
  }
}

/** 写全部书签：内存立即生效，磁盘异步跟上。 */
export function saveBookmarks(
  list: SftpBookmark[]
): void {
  writeData(
    DataName.sftpBookmarks,
    JSON.stringify(list)
  );
}

/**
 * 切换某个目录的收藏态：已收藏则移除，未收藏则追加。
 *
 * 按 (side, host, path) 判重 —— 同一路径重复收藏不产生第二条。
 */
export function toggledBookmarks(
  list: SftpBookmark[],
  side: PaneSide,
  host: string,
  path: string
): SftpBookmark[] {
  const exists = list.some(
    item =>
      item.side === side &&
      item.host === host &&
      item.path === path
  );
  if (exists) {
    return list.filter(
      item =>
        !(
          item.side === side &&
          item.host === host &&
          item.path === path
        )
    );
  }
  return [...list, { side, host, path }];
}

/** 删除一条书签；不存在时原样返回。 */
export function removedBookmark(
  list: SftpBookmark[],
  side: PaneSide,
  host: string,
  path: string
): SftpBookmark[] {
  return list.filter(
    item =>
      !(
        item.side === side &&
        item.host === host &&
        item.path === path
      )
  );
}

/** 某侧某主机可用的书签路径列表（本地栏 host 恒为空串）。 */
export function bookmarkPathsFor(
  list: SftpBookmark[],
  side: PaneSide,
  host: string
): string[] {
  return list
    .filter(
      item =>
        item.side === side && item.host === host
    )
    .map(item => item.path);
}
