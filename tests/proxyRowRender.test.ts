import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// i18n 用 useSyncExternalStore，SSR 下缺 getServerSnapshot 会抛。
// 这里让 t 直接回显 key，断言就能按 key 匹配、不受文案改动影响
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));
// 连通性测试要 invoke tauri，SSR 渲染阶段不会触发，但 import 链会拉到
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

import { defaultSettings } from "@/settings/lib/settings";

/**
 * 代理设置的折叠行为。
 *
 * 背景（2026-10-18 用户要求）：原先「网络代理」与「代理地址」是**两张
 * 独立卡片**，关掉开关后地址那一张仍然躺在设置页里，只是置灰 —— 看着
 * 像「地址填错了所以不能编辑」，其实与对错无关。
 *
 * 改为同一张卡片、关闭时地址区**整个不渲染**：卡片回到最简的一行开关，
 * 视觉上就是「这功能没开」，不需要读任何解释。
 *
 * 为什么单测能抓：这是纯视觉/结构问题，tsc / eslint / stylelint / build
 * 全绿，只有渲染断言能发现「置灰了但还占着位置」。
 */
async function render(enabled: boolean) {
  const { default: ProxyRow } =
    await import("@/settings/components/ProxyRow");
  return renderToStaticMarkup(
    createElement(ProxyRow, {
      settings: {
        ...defaultSettings,
        proxyEnabled: enabled,
        proxyUrl: "127.0.0.1:7890"
      },
      onChange: () => {}
    })
  );
}

describe("代理设置：开关关闭时收起地址区", () => {
  it("关闭时看不到地址输入框与示例按钮", async () => {
    const html = await render(false);
    expect(html).not.toContain("proxy-input");
    expect(html).not.toContain("proxy-example");
    // 测试按钮同样收起来 —— 它对「没开代理」的用户毫无意义
    expect(html).not.toContain("proxy-test");
  });

  it("关闭时仍保留开关与说明", async () => {
    const html = await render(false);
    expect(html).toContain("proxy.title");
    // 说明里要交代「关闭时是什么行为」，否则用户不知道关掉意味着什么
    expect(html).toContain("proxy.desc");
  });

  it("开启后地址区出现", async () => {
    const html = await render(true);
    expect(html).toContain("proxy-input");
    expect(html).toContain("proxy-example");
    expect(html).toContain("proxy-test");
  });

  it("开启且地址合法时，标题右侧显示地址摘要", async () => {
    const html = await render(true);
    // 摘要复用 SettingsRow 的 titleExtra 弱色位
    expect(html).toContain("proxy-summary");
    expect(html).toContain("127.0.0.1:7890");
  });

  it("测试结论不残留：未测试时不显示状态文案", async () => {
    const html = await render(true);
    expect(html).not.toContain("proxy.status.ok");
    expect(html).not.toContain(
      "proxy.status.fail"
    );
    expect(html).not.toContain(
      "proxy.status.reachable"
    );
  });
});
