import { describe, it, expect } from "vitest";
import {
  markSearchSelection,
  normalizeRange
} from "@/terminal/lib/terminalSelection";

/**
 * 终端「仅文字选区」覆盖层的拖拽生命周期。
 *
 * ## 为什么值得单测
 *
 * 2026-10-15 用户报「从 AI 助手划词却划到终端里」：终端拖拽的 mouseup
 * 若在窗口外松开就会漏摘，document 上的 mousemove 一直挂着且 dragStart
 * 不清 —— 之后在 AI 面板里按住鼠标拖动，指针坐标被 locateMouse 折算成
 * 终端网格坐标，在终端里画出用户并没有做的选区。这类 bug 的症状在
 * 另一个面板里，极难反推到终端的事件泄漏上，所以把「清理路径」钉死。
 */
describe("终端选区覆盖层", () => {
  describe("normalizeRange（反向拖选排序）", () => {
    it("指针在锚点之后：原序", () => {
      expect(
        normalizeRange(
          { x: 2, y: 3 },
          { x: 5, y: 3 }
        )
      ).toEqual({
        start: { x: 2, y: 3 },
        end: { x: 5, y: 3 }
      });
    });

    it("指针在锚点之前（从右往左）：整体交换", () => {
      expect(
        normalizeRange(
          { x: 8, y: 1 },
          { x: 2, y: 0 }
        )
      ).toEqual({
        start: { x: 2, y: 0 },
        end: { x: 8, y: 1 }
      });
    });

    it("同行但列在左：按列交换", () => {
      expect(
        normalizeRange(
          { x: 7, y: 4 },
          { x: 1, y: 4 }
        )
      ).toEqual({
        start: { x: 1, y: 4 },
        end: { x: 7, y: 4 }
      });
    });

    it("同行同列：原序（零宽选区也合法）", () => {
      const point = { x: 3, y: 2 };
      expect(
        normalizeRange(point, point)
      ).toEqual({
        start: point,
        end: point
      });
    });
  });

  describe("拖拽清理路径（防事件泄漏）", () => {
    it("mouseup 与 blur 走同一条清理函数", async () => {
      const src = (
        await import("@/terminal/lib/terminalSelection?raw")
      ).default;
      // 一个 stopDirectDraw 同时摘 mousemove / mouseup / blur 三件套
      expect(src).toContain("stopDirectDraw");
      expect(src).toMatch(
        /document\.removeEventListener\(\s*"mousemove",\s*handleMouseMove,\s*true\s*\)/
      );
      // ⚠️ blur 兜底是 2026-10-15 的修复核心：窗外松手收不到 mouseup。
      // 断言用 \s* 不用字面换行：仓库 CRLF，\n 匹配不上
      expect(src).toMatch(
        /window\.addEventListener\(\s*"blur",\s*stopDirectDraw\s*\)/
      );
      expect(src).toMatch(
        /window\.removeEventListener\(\s*"blur",\s*stopDirectDraw\s*\)/
      );
    });

    it("mousedown 挂监听前先幂等重置（清掉上次漏摘的 dragStart）", async () => {
      const src = (
        await import("@/terminal/lib/terminalSelection?raw")
      ).default;
      // stopDirectDraw() 必须出现在 addEventListener("mousemove") 之前
      const resetAt = src.indexOf(
        "stopDirectDraw();"
      );
      const armAt = src.search(
        /document\.addEventListener\(\s*"mousemove"/
      );
      expect(resetAt).toBeGreaterThan(-1);
      expect(armAt).toBeGreaterThan(-1);
      expect(resetAt).toBeLessThan(armAt);
    });
  });

  it("搜索选区标记走 WeakMap（不泄漏 Terminal 实例）", () => {
    // 标记函数存在且对任意假对象不炸即可 —— 真实行为在渲染层
    const fake = {} as never;
    expect(() =>
      markSearchSelection(fake)
    ).not.toThrow();
  });
});
