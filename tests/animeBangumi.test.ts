/**
 * Bangumi 匹配策略（src/anime/lib/bangumi.ts）的判定用例。
 *
 * 守住「宁可不同步也不同步错」：标题匹配只认完全一致（原文或去季标后），
 * 模糊包含不认——「鬼灭之刃」会撞上「鬼灭之刃 锻刀村篇」这种独立条目，
 * 认错了会把别人的集打成已看。
 */
import { describe, expect, it } from "vitest";
import {
  cleanSubjectTitle,
  pickSubject
} from "@/anime/lib/bangumi";

describe("cleanSubjectTitle", () => {
  it("摘掉季标与后面的尾巴", () => {
    expect(
      cleanSubjectTitle("某某剧 第二季 最终章")
    ).toBe("某某剧");
  });

  it("摘掉【】标签与结尾标点", () => {
    expect(
      cleanSubjectTitle("【国语】某某剧（2024）")
    ).toBe("某某剧");
  });

  it("普通剧名原样返回", () => {
    expect(
      cleanSubjectTitle("葬送的芙莉莲")
    ).toBe("葬送的芙莉莲");
  });
});

describe("pickSubject", () => {
  const hit = (
    id: number,
    name: string,
    nameCn: string
  ) => ({ id, name, name_cn: nameCn });

  it("中文名完全一致才认", () => {
    expect(
      pickSubject(
        [
          hit(
            1,
            " sousou no frieren ",
            "葬送的芙莉莲"
          )
        ],
        "葬送的芙莉莲"
      )?.id
    ).toBe(1);
  });

  it("原文（日文名）一致也认", () => {
    expect(
      pickSubject(
        [
          hit(
            2,
            "葬送のフリーレン",
            "葬送的芙莉莲"
          )
        ],
        "葬送のフリーレン"
      )?.id
    ).toBe(2);
  });

  it("去季标后一致也认", () => {
    expect(
      pickSubject(
        [hit(3, "XXX", "斗罗大陆")],
        "斗罗大陆 第二部"
      )?.id
    ).toBe(3);
  });

  it("模糊包含不认（同系列不同季是独立条目）", () => {
    expect(
      pickSubject(
        [hit(4, "XXX", "鬼灭之刃 锻刀村篇")],
        "鬼灭之刃"
      )
    ).toBeNull();
  });

  it("没有结果返回 null", () => {
    expect(
      pickSubject([], "不存在的剧")
    ).toBeNull();
  });
});
