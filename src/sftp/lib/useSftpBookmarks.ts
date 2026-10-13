import { useCallback, useState } from "react";
import {
  loadBookmarks,
  removedBookmark,
  saveBookmarks,
  toggledBookmarks,
  type SftpBookmark
} from "@/sftp/lib/sftpBookmarks";
import type { PaneSide } from "@/sftp/lib/sftpUtils";

/** 目录书签：启动时从数据文件读一次，之后内存先行、异步落盘。 */
export function useSftpBookmarks() {
  const [bookmarks, setBookmarks] = useState<
    SftpBookmark[]
  >(loadBookmarks);

  /** 收藏 / 取消收藏某栏某主机的一个目录。 */
  const toggleBookmark = useCallback(
    (
      side: PaneSide,
      host: string,
      path: string
    ) => {
      setBookmarks(previous => {
        const next = toggledBookmarks(
          previous,
          side,
          host,
          path
        );
        saveBookmarks(next);
        return next;
      });
    },
    []
  );

  /** 删除一条书签。 */
  const removeBookmark = useCallback(
    (
      side: PaneSide,
      host: string,
      path: string
    ) => {
      setBookmarks(previous => {
        const next = removedBookmark(
          previous,
          side,
          host,
          path
        );
        saveBookmarks(next);
        return next;
      });
    },
    []
  );

  return {
    bookmarks,
    toggleBookmark,
    removeBookmark
  };
}
