import { describe, expect, it } from "vitest";
import {
  clampScrollback,
  DEFAULT_SCROLLBACK,
  MAX_SCROLLBACK,
  MIN_SCROLLBACK,
  SCROLLBACK_PRESETS
} from "@/settings/lib/settings";

/**
 * 回滚行数（xterm scrollback）的取值校验。
 *
 * 设置值可能来自手改的设置文件或早期版本的数据，必须保证传进 xterm 的
 * 一定落在合法区间内 —— xterm 对非法 scrollback 的反应是静默丢弃缓冲，
 * 用户只会看到「历史输出莫名其妙没了」。
 */
describe("回滚行数 clamp", () => {
  it("合法值原样保留", () => {
    expect(clampScrollback(5000)).toBe(5000);
    expect(clampScrollback("20000")).toBe(20000);
  });

  it("超出上限夹到上限", () => {
    expect(clampScrollback(999999)).toBe(
      MAX_SCROLLBACK
    );
  });

  it("低于下限的非正数退回默认，正数夹到下限", () => {
    expect(clampScrollback(1)).toBe(
      MIN_SCROLLBACK
    );
    expect(clampScrollback(0)).toBe(
      DEFAULT_SCROLLBACK
    );
    expect(clampScrollback(-100)).toBe(
      DEFAULT_SCROLLBACK
    );
  });

  it("非法值退回默认", () => {
    expect(clampScrollback(undefined)).toBe(
      DEFAULT_SCROLLBACK
    );
    expect(clampScrollback(null)).toBe(
      DEFAULT_SCROLLBACK
    );
    expect(clampScrollback("abc")).toBe(
      DEFAULT_SCROLLBACK
    );
    expect(clampScrollback(NaN)).toBe(
      DEFAULT_SCROLLBACK
    );
  });

  it("小数取整", () => {
    expect(clampScrollback(5000.6)).toBe(5001);
  });

  it("预设档位都在合法区间内，且包含默认值", () => {
    for (const preset of SCROLLBACK_PRESETS) {
      expect(preset).toBeGreaterThanOrEqual(
        MIN_SCROLLBACK
      );
      expect(preset).toBeLessThanOrEqual(
        MAX_SCROLLBACK
      );
      expect(clampScrollback(preset)).toBe(
        preset
      );
    }
    expect(SCROLLBACK_PRESETS).toContain(
      DEFAULT_SCROLLBACK
    );
  });
});
