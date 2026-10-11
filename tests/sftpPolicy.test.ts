// 传输冲突探测的纯逻辑。
//
// 为什么单独测：冲突判定决定了是否弹策略框、"续传"按钮显隐，
// 判错方向要么静默覆盖用户文件、要么按钮永远不出现。
import { describe, expect, it } from "vitest";
import {
  findCollisions,
  hasResumable,
  type PaneEntry
} from "@/sftp/lib/sftpUtils";

function entry(
  name: string,
  size: number,
  isDir = false
): PaneEntry {
  return {
    name,
    path: `/src/${name}`,
    isDir,
    size
  };
}

const targetListing = [
  entry("old.txt", 100),
  entry("partial.bin", 300),
  entry("bigger.bin", 900),
  entry("samedir", 0, true)
];

describe("findCollisions", () => {
  it("按名字找出与目标目录同名的条目", () => {
    const collisions = findCollisions(
      [entry("old.txt", 50), entry("new.txt", 1)],
      targetListing
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.name).toBe("old.txt");
  });

  it("目标同名是目录也算冲突（类型不一致后端必报错）", () => {
    expect(
      findCollisions(
        [entry("samedir", 0)],
        targetListing
      )
    ).toHaveLength(1);
  });

  it("无冲突 / 空目标时返回空数组", () => {
    expect(
      findCollisions([], targetListing)
    ).toEqual([]);
    expect(
      findCollisions([entry("new.txt", 1)], [])
    ).toEqual([]);
  });
});

describe("hasResumable", () => {
  it("目标同名文件比源小 → 可续传", () => {
    expect(
      hasResumable(
        [entry("partial.bin", 800)],
        targetListing
      )
    ).toBe(true);
  });

  it("目标不比源小 / 目标是目录 / 源是目录 → 不可续传", () => {
    expect(
      hasResumable(
        [entry("bigger.bin", 800)],
        targetListing
      )
    ).toBe(false);
    expect(
      hasResumable(
        [entry("old.txt", 50)],
        targetListing
      )
    ).toBe(false);
    expect(
      hasResumable(
        [entry("samedir", 0, true)],
        targetListing
      )
    ).toBe(false);
  });
});
