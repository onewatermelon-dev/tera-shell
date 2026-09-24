import { describe, expect, it } from "vitest";
import { formatContextWindow } from "../src/settings/lib/modelProviders";

describe("formatContextWindow", () => {
  it("纯数字换算成 K / M 缩写", () => {
    expect(formatContextWindow("1000000")).toBe(
      "1M"
    );
    expect(formatContextWindow("262144")).toBe(
      "262.1K"
    );
    expect(formatContextWindow("204800")).toBe(
      "204.8K"
    );
    expect(
      formatContextWindow("1000000000")
    ).toBe("1000M");
    expect(formatContextWindow("512")).toBe(
      "512"
    );
  });

  it("非数字原样返回", () => {
    expect(formatContextWindow("1M")).toBe("1M");
    expect(formatContextWindow("")).toBe("");
    expect(formatContextWindow("abc")).toBe(
      "abc"
    );
  });
});
