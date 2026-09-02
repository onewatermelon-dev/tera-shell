import { describe, expect, it } from "vitest";
import type { SavedSession } from "@/domain/session";

/**
 * duplicate() 标签命名规则的最小复刻（与 useTerminals.ts 保持一致）：
 * 第一个实例用原名，之后依次 (2)(3)…；删除中间实例后新实例补位。
 */
function nextName(
  openedNames: string[],
  base: string
): string {
  let n = 1;
  const nameAt = (i: number) =>
    i === 1 ? base : `${base} (${i})`;
  while (openedNames.includes(nameAt(n))) n++;
  return nameAt(n);
}

describe("duplicate 标签命名", () => {
  const session = {
    name: "177.3.41.74"
  } as SavedSession;
  it("首个实例无后缀，后续依次编号", () => {
    expect(nextName([], session.name)).toBe(
      "177.3.41.74"
    );
    expect(
      nextName(["177.3.41.74"], session.name)
    ).toBe("177.3.41.74 (2)");
    expect(
      nextName(
        ["177.3.41.74", "177.3.41.74 (2)"],
        session.name
      )
    ).toBe("177.3.41.74 (3)");
  });
  it("删除中间实例后编号补位", () => {
    expect(
      nextName(
        ["177.3.41.74", "177.3.41.74 (3)"],
        session.name
      )
    ).toBe("177.3.41.74 (2)");
  });
});
