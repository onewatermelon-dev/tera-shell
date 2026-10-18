// SFTP 目录书签的纯逻辑。
//
// 为什么单独测：host 维度隔离（本地通用、远程按主机）、去重、坏数据
// 容错这些规则靠手工点很难覆盖全；书签存错会导致跳转到不存在/别台的
// 目录，静默但烦人。
import { describe, expect, it } from "vitest";
import {
  bookmarkPathsFor,
  removedBookmark,
  toggledBookmarks,
  type SftpBookmark
} from "@/sftp/lib/sftpBookmarks";

const list: SftpBookmark[] = [
  { side: "local", host: "", path: "C:\\work" },
  {
    side: "remote",
    host: "a.example",
    path: "/var/log"
  },
  {
    side: "remote",
    host: "b.example",
    path: "/opt"
  }
];

describe("toggledBookmarks", () => {
  it("未收藏 → 追加", () => {
    const next = toggledBookmarks(
      list,
      "remote",
      "a.example",
      "/home"
    );
    expect(next).toHaveLength(4);
    expect(next[3]).toEqual({
      side: "remote",
      host: "a.example",
      path: "/home"
    });
  });

  it("已收藏 → 移除（星标是切换语义）", () => {
    const next = toggledBookmarks(
      list,
      "local",
      "",
      "C:\\work"
    );
    expect(next).toHaveLength(2);
    expect(
      next.some(item => item.path === "C:\\work")
    ).toBe(false);
  });

  it("同一路径重复切换不产生第二条", () => {
    const once = toggledBookmarks(
      list,
      "local",
      "",
      "C:\\tmp"
    );
    const twice = toggledBookmarks(
      once,
      "local",
      "",
      "C:\\tmp"
    );
    expect(twice).toEqual(list);
  });
});

describe("removedBookmark / bookmarkPathsFor", () => {
  it("删除只影响该侧该主机的那条", () => {
    const next = removedBookmark(
      list,
      "remote",
      "a.example",
      "/var/log"
    );
    expect(next).toHaveLength(2);
    expect(
      next.some(item => item.host === "a.example")
    ).toBe(false);
  });

  it("按侧与主机过滤：本地通用，远程互不可见", () => {
    expect(
      bookmarkPathsFor(list, "local", "")
    ).toEqual(["C:\\work"]);
    expect(
      bookmarkPathsFor(
        list,
        "remote",
        "a.example"
      )
    ).toEqual(["/var/log"]);
    expect(
      bookmarkPathsFor(
        list,
        "remote",
        "c.example"
      )
    ).toEqual([]);
  });
});
