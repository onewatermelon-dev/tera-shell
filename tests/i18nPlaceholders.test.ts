import { describe, it, expect } from "vitest";

/**
 * i18n 占位符语法守卫。
 *
 * 项目自研翻译器（createTranslator）只认**单花括号** `\{(\w+)\}`——
 * 写成 i18next 风格的双花括号 `{{count}}` 不会报错，只会在界面上原样
 * 露出「还有 {{count}} 步」（2026-10-17 ai.plan.more 真实踩过：
 * tsc / eslint / 渲染测试全绿，因为测试里 i18n 被 mock 成返回键名，
 * 压根走不到替换逻辑）。
 *
 * 所以这里直接扫字典源码：出现 `{{` 即失败。
 */
describe("i18n 占位符语法", () => {
  it("字典里不允许出现双花括号（翻译器只替换 {name} 单花括号）", async () => {
    const src = (
      await import("@/settings/lib/i18n.ts?raw")
    ).default;
    const hits: string[] = [];
    for (const match of src.matchAll(
      /\{\{[^}]*\}\}/g
    ))
      hits.push(match[0]);
    expect(
      hits,
      "出现了双花括号占位符 —— 界面会原样露出 {{...}}，改成单花括号 {name}"
    ).toEqual([]);
  });

  it("翻译器的替换正则仍是单花括号（改了它这条守卫才配套）", async () => {
    const src = (
      await import("@/settings/lib/i18n.ts?raw")
    ).default;
    expect(src).toContain("/\\{(\\w+)\\}/g");
  });
});
