import { expect, test } from "vitest";
import {
  formatMessageAge,
  positionMessageTip,
  shouldDismissTipOnScroll
} from "@/terminal/components/aicss/ChatMessageActions";

/**
 * 最小 DOM 替身：只实现被测函数用到的那一个方法。
 *
 * 本项目测试跑在 `environment: "node"` 下，没有 window / document /
 * Element 可用，装 jsdom 又得改依赖树，所以这里按「鸭子类型」造结构化
 * 的假对象 —— 被测函数正是靠鸭子类型判定的（见 isNodeLike 的注释），
 * 所以替身与真实 DOM 的行为完全对齐。
 */
function node(containsIds: string[], id: string) {
  return {
    id,
    contains(other: { id: string } | null) {
      return Boolean(
        other && containsIds.includes(other.id)
      );
    }
  };
}

test("消息相对时间随语言切换", () => {
  const sentAt = new Date("2026-10-05T06:00:00Z");
  const now = sentAt.getTime() + 2 * 60_000;
  expect(
    formatMessageAge(sentAt, now, "zh-CN")
  ).toBe("2 分钟前");
  expect(
    formatMessageAge(sentAt, now, "en-US")
  ).toBe("2m ago");
});

test("提示气泡保持在 AI 面板内", () => {
  const point = positionMessageTip(
    { left: 470, top: 10, width: 20 },
    {
      left: 100,
      right: 500,
      top: 0,
      bottom: 300
    },
    { width: 120, height: 24 }
  );
  expect(point).toEqual({ x: 432, y: 32 });
});

test("滚动消息列表时收起气泡（锚点会移位）", () => {
  const list = node(["anchor"], "list");
  const anchor = node([], "anchor");
  expect(
    shouldDismissTipOnScroll(list, anchor)
  ).toBe(true);
});

test("滚动别处时保留气泡（锚点没动）", () => {
  const anchor = node([], "anchor");
  const elsewhere = node([], "elsewhere");
  expect(
    shouldDismissTipOnScroll(elsewhere, anchor)
  ).toBe(false);
});

test("滚动 window（无 contains）时收起气泡", () => {
  const anchor = node([], "anchor");
  // window 没有 contains，判不出归属 → 保守关
  expect(
    shouldDismissTipOnScroll({}, anchor)
  ).toBe(true);
});

test("滚动 document 时收起气泡", () => {
  const anchor = node([], "anchor");
  // document 自带 contains，锚点在文档内 → true
  expect(
    shouldDismissTipOnScroll(
      node(["anchor"], "document"),
      anchor
    )
  ).toBe(true);
});

test("判不出目标或锚点已卸载时保守关闭", () => {
  const anchor = node([], "anchor");
  // 没有事件目标
  expect(
    shouldDismissTipOnScroll(null, anchor)
  ).toBe(true);
  // 锚点已卸载 → 收手，别把气泡留在屏幕上
  expect(
    shouldDismissTipOnScroll(
      node([], "list"),
      null
    )
  ).toBe(true);
});
