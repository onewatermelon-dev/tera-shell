import { describe, expect, it } from "vitest";
import {
  buildSearchRowMap,
  escapeSearchText,
  type SearchCell
} from "../src/terminal/lib/searchTextOverlay";

describe("搜索文字覆盖层", () => {
  it("字面搜索会转义正则特殊字符", () => {
    expect(escapeSearchText("a.*[b]")).toBe(
      "a\\.\\*\\[b\\]"
    );
  });

  it("中文字符按两列映射后续文字位置", () => {
    const cells: SearchCell[] = [
      { getChars: () => "a", getWidth: () => 1 },
      { getChars: () => "中", getWidth: () => 2 },
      { getChars: () => "", getWidth: () => 0 },
      { getChars: () => "b", getWidth: () => 1 }
    ];
    expect(
      buildSearchRowMap(
        cells.length,
        column => cells[column]
      )
    ).toEqual({
      text: "a中b",
      columns: [0, 1, 3],
      widths: [1, 2, 1]
    });
  });
});
