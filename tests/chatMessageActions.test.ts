import { expect, test } from "vitest";
import {
  formatMessageAge,
  positionMessageTip
} from "@/terminal/components/aicss/ChatMessageActions";

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
