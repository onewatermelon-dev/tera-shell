/**
 * 目录栏虚拟滚动的区间计算。
 *
 * 边界容易错（负 scrollTop、视口未测出、滚到底），错的表现是
 * 「滚到底少几行」或「快速滚动露白」，从界面上很难反推，所以钉住。
 */

import { describe, expect, it } from "vitest";
import {
  OVERSCAN,
  ROW_HEIGHT,
  visibleRange
} from "@/terminal/components/directory/virtual";

/** 400px 视口能放几行（跟着 ROW_HEIGHT 走，别硬编码） */
const rowsIn400 = Math.ceil(400 / ROW_HEIGHT);

describe("visibleRange", () => {
  it("空列表返回空区间", () => {
    expect(visibleRange(0, 400, 0)).toEqual({
      start: 0,
      end: 0
    });
  });

  it("顶部：从 0 开始，按视口行数 + 下缓冲", () => {
    const { start, end } = visibleRange(
      0,
      400,
      1000
    );
    expect(start).toBe(0);
    expect(end).toBe(rowsIn400 + OVERSCAN);
  });

  it("中部：起点带缓冲，向后多渲染视口 + 缓冲", () => {
    const scrollTop = ROW_HEIGHT * 100;
    const { start, end } = visibleRange(
      scrollTop,
      400,
      1000
    );
    expect(start).toBe(100 - OVERSCAN);
    expect(end).toBe(100 + rowsIn400 + OVERSCAN);
  });

  it("底部：end 不越过总数", () => {
    const count = 120;
    const { end } = visibleRange(
      ROW_HEIGHT * 118,
      400,
      count
    );
    expect(end).toBe(count);
  });

  it("视口还没测出来（0）时也先渲染一批，避免首帧空白", () => {
    const { start, end } = visibleRange(0, 0, 50);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(0);
  });

  it("负的 scrollTop（弹性滚动）按 0 处理", () => {
    expect(
      visibleRange(-200, 400, 100).start
    ).toBe(0);
  });
});
