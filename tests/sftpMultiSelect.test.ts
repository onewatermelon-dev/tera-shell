// SFTP 文件列表多选的选择计算。
//
// 为什么单独测：Ctrl/Shift/右键的选择语义在真机上要逐个手势点过去，
// 范围选择（锚点在前/在后、跨目录残留选中）靠手工很难覆盖全。
import { describe, expect, it } from "vitest";
import {
  nextSelection,
  resolveSelected
} from "@/sftp/lib/sftpUtils";

const paths = [
  "/d/a.txt",
  "/d/b.txt",
  "/d/c.txt",
  "/d/d.txt"
];

describe("nextSelection", () => {
  it("普通点击：只选它", () => {
    expect(
      nextSelection(
        new Set(["/d/a.txt"]),
        paths,
        "/d/c.txt",
        {}
      )
    ).toEqual(new Set(["/d/c.txt"]));
  });

  it("Ctrl 点击：切换该行，其余保留", () => {
    expect(
      nextSelection(
        new Set(["/d/a.txt"]),
        paths,
        "/d/c.txt",
        { ctrl: true, anchor: "/d/a.txt" }
      )
    ).toEqual(new Set(["/d/a.txt", "/d/c.txt"]));
    // 再 Ctrl 点一次同一个 = 取消
    expect(
      nextSelection(
        new Set(["/d/a.txt", "/d/c.txt"]),
        paths,
        "/d/c.txt",
        { ctrl: true, anchor: "/d/c.txt" }
      )
    ).toEqual(new Set(["/d/a.txt"]));
  });

  it("Shift 点击：锚点在前时正向扫到它", () => {
    expect(
      nextSelection(
        new Set(),
        paths,
        "/d/c.txt",
        {
          shift: true,
          anchor: "/d/a.txt"
        }
      )
    ).toEqual(
      new Set([
        "/d/a.txt",
        "/d/b.txt",
        "/d/c.txt"
      ])
    );
  });

  it("Shift 点击：锚点在后时反向扫，范围替换整个选中", () => {
    expect(
      nextSelection(
        new Set(["/d/a.txt"]),
        paths,
        "/d/a.txt",
        { shift: true, anchor: "/d/c.txt" }
      )
    ).toEqual(
      new Set([
        "/d/a.txt",
        "/d/b.txt",
        "/d/c.txt"
      ])
    );
  });

  it("Shift 但没有锚点：退化为普通点击", () => {
    expect(
      nextSelection(
        new Set(),
        paths,
        "/d/b.txt",
        {
          shift: true,
          anchor: null
        }
      )
    ).toEqual(new Set(["/d/b.txt"]));
  });
});

describe("resolveSelected", () => {
  const entries = paths.map(path => ({
    path,
    name: path.slice(3),
    isDir: false,
    size: 0
  }));

  it("按列表顺序返回选中条目", () => {
    expect(
      resolveSelected(
        entries,
        new Set(["/d/c.txt", "/d/a.txt"])
      )
    ).toEqual([entries[0], entries[2]]);
  });

  it("过滤掉列表里已消失的路径（导航/删除后的残留选中）", () => {
    expect(
      resolveSelected(
        entries.slice(2),
        new Set(["/d/a.txt", "/d/c.txt"])
      )
    ).toEqual([entries[2]]);
  });

  it("空选中返回空数组", () => {
    expect(
      resolveSelected(entries, new Set())
    ).toEqual([]);
  });
});
