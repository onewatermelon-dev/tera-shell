import { describe, expect, it } from "vitest";
import {
  findMatches,
  unescapeReplacement,
  isRegexValid,
  replaceAllMatches,
  replaceRange
} from "../src/terminal/components/drawers/CommandDrawer";

const base = {
  regex: false,
  caseSensitive: false,
  wholeWord: false
};

describe("命令抽屉查找替换", () => {
  it("字面模式：给出全部匹配区间", () => {
    const text = "ping 1.1.1.1 && ping 1.1.1.1";
    expect(
      findMatches(text, "1.1.1.1", base)
    ).toEqual([
      [5, 12],
      [21, 28]
    ]);
    expect(
      findMatches(text, "不存在", base)
    ).toEqual([]);
    expect(findMatches(text, "", base)).toEqual(
      []
    );
  });

  it("默认不区分大小写；Aa 打开后区分", () => {
    expect(
      findMatches("Ls Ls ls", "ls", base)
    ).toEqual([
      [0, 2],
      [3, 5],
      [6, 8]
    ]);
    expect(
      findMatches("Ls Ls ls", "ls", {
        ...base,
        caseSensitive: true
      })
    ).toEqual([[6, 8]]);
  });

  it("全字匹配：ab 打开后不算子串", () => {
    expect(
      findMatches("ls lsblk ls", "ls", base)
    ).toHaveLength(3);
    expect(
      findMatches("ls lsblk ls", "ls", {
        ...base,
        wholeWord: true
      })
    ).toEqual([
      [0, 2],
      [9, 11]
    ]);
  });

  it("正则模式：坐标按捕获内容计", () => {
    expect(
      findMatches(
        "root@1.1.1.1: root@2.2.2.2:",
        String.raw`root@[\d.]+:`,
        { ...base, regex: true }
      )
    ).toEqual([
      [0, 13],
      [14, 27]
    ]);
  });

  it("正则非法返回空", () => {
    expect(
      findMatches("abc", "a(", {
        ...base,
        regex: true
      })
    ).toEqual([]);
  });

  it("区间替换", () => {
    expect(
      replaceRange("abcdef", 2, 4, "XY")
    ).toBe("abXYef");
  });

  it("全部替换（replaceAllMatches）", () => {
    expect(
      replaceAllMatches(
        "ip ip ip",
        "ip",
        "host",
        base
      )
    ).toBe("host host host");
    expect(
      replaceAllMatches("abc", "", "host", base)
    ).toBe("abc");
  });

  it("正则替换串转义：换行 制表与反斜杠", () => {
    // 用户在替换框输入 \n 两个字符 → 替换成真正的换行
    expect(unescapeReplacement("a\\nb")).toBe(
      "a\nb"
    );
    expect(unescapeReplacement("x\\ty")).toBe(
      "x\ty"
    );
    // \\ 还原成一个反斜杠
    expect(unescapeReplacement("c\\\\d")).toBe(
      "c\\d"
    );
    // 未知转义原样保留
    expect(unescapeReplacement("\\q")).toBe(
      "\\q"
    );
  });

  it("正则合法性检查", () => {
    expect(isRegexValid("a\\.b")).toBe(true);
    expect(isRegexValid("a(")).toBe(false);
    expect(isRegexValid("")).toBe(true);
  });
});
