import { describe, expect, it } from "vitest";
import { measureSnapshot } from "../src/terminal/lib/terminalSnapshot";

describe("终端快照测量", () => {
  it("列数取最长行", () => {
    const m = measureSnapshot("abc\nhello world");
    expect(m.cols).toBe(11);
    expect(m.lines).toHaveLength(2);
    expect(m.truncated).toBe(false);
  });

  it("Tab 展开为 4 空格再量宽度", () => {
    const m = measureSnapshot("a\tb");
    expect(m.cols).toBe(6);
    expect(m.lines[0]).toBe("a    b");
  });

  it("超行截断：保留前 500 行并追加标记行", () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `line-${i}`
    );
    const m = measureSnapshot(lines.join("\n"));
    expect(m.truncated).toBe(true);
    expect(m.lines).toHaveLength(501);
    expect(m.lines.at(-1)).toContain("已截断");
  });

  it("超宽截断到 200 列", () => {
    const m = measureSnapshot("x".repeat(300));
    expect(m.cols).toBe(200);
    // 列截断只影响布局宽度，行文本不裁，交给绘制层 fillText 自然裁剪
    expect(m.lines[0]).toHaveLength(300);
  });

  it("CRLF 归一，尾部空行全部去掉", () => {
    const m = measureSnapshot("a\r\n\r\n\r\n");
    expect(m.lines).toEqual(["a"]);
  });
});
