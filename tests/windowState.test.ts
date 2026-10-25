import { describe, it, expect } from "vitest";
import {
  sanitizeWindowState,
  type WindowState
} from "@/app/lib/windowState";

/**
 * 窗口位置/大小存档的清洗。
 *
 * 这个文件是纯文本、可手改，也可能因为崩溃只写了一半。清洗的底线是
 * **坏数据不能把窗口开到屏幕外**——所以位置必须是有限数，尺寸越界要
 * 钳回合法区间（而不是整条作废：位置还有参考价值）。
 */

const GOOD: WindowState = {
  x: 120,
  y: 80,
  width: 1440,
  height: 900,
  maximized: false
};

describe("窗口状态清洗", () => {
  it("正常值原样保留", () => {
    expect(sanitizeWindowState(GOOD)).toEqual(
      GOOD
    );
  });

  it("位置取整", () => {
    expect(
      sanitizeWindowState({
        ...GOOD,
        x: 120.6,
        y: 79.2
      })
    ).toMatchObject({ x: 121, y: 79 });
  });

  it("太小/太大的尺寸被钳回合法区间", () => {
    const small = sanitizeWindowState({
      ...GOOD,
      width: 10,
      height: 10
    });
    expect(small?.width).toBeGreaterThanOrEqual(
      720
    );
    expect(small?.height).toBeGreaterThanOrEqual(
      480
    );

    const huge = sanitizeWindowState({
      ...GOOD,
      width: 999999,
      height: 999999
    });
    expect(huge?.width).toBeLessThanOrEqual(7680);
    expect(huge?.height).toBeLessThanOrEqual(
      4320
    );
  });

  it("非数字 / NaN / 缺字段一律作废", () => {
    expect(
      sanitizeWindowState({
        ...GOOD,
        x: "120"
      })
    ).toBeNull();
    expect(
      sanitizeWindowState({
        ...GOOD,
        y: Number.NaN
      })
    ).toBeNull();
    expect(
      sanitizeWindowState({
        ...GOOD,
        width: undefined
      })
    ).toBeNull();
    expect(sanitizeWindowState(null)).toBeNull();
    expect(
      sanitizeWindowState("乱写")
    ).toBeNull();
  });

  it("maximized 只认 true", () => {
    expect(
      sanitizeWindowState({
        ...GOOD,
        maximized: "true"
      })?.maximized
    ).toBe(false);
    expect(
      sanitizeWindowState({
        ...GOOD,
        maximized: true
      })?.maximized
    ).toBe(true);
  });
});
