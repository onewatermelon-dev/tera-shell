import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";
// ?raw 读源码：SettingsPage 的依赖链太长（tauri/设置 store/heroui），
// 单测里 import 组件会连带把它们全加载
import settingsPageSource from "@/settings/components/SettingsPage.tsx?raw";

/**
 * 配色方案分区：整页占满屏幕高，外层不滚动，滚动只发生在方案列表里。
 *
 * 背景（2026-10-15 用户要求）：原实现把 `.scheme-list` 写死
 * `max-height: 520px`，选择区占不满屏幕、下方留空白，且外层
 * `.settings-content` 是整页滚动 —— 滚一下是整个设置在滚，不是
 * 方案列表在滚。
 *
 * 为什么单测能抓：这类问题纯视觉，tsc/eslint/stylelint 全绿，
 * 只有编译真实 sass 后检查「占满链路上每一层是否都放开了收缩」
 * 才看得出来。链路上任何一层少了 min-height:0，flex 子项的内容
 * 高度就会把列表顶高，外层又冒出滚动条。
 */
describe("配色方案分区占满整页、只滚动方案列表", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /** 从编译后的 CSS 里取出指定选择器的声明块（取不到返回空串）。 */
  function ruleOf(selector: string): string {
    const re = new RegExp(
      `(?:^|[},])\\s*${selector.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      )}\\s*\\{([^}]*)\\}`,
      "m"
    );
    return css.match(re)?.[1] ?? "";
  }

  it("只有配色方案分区挂 fill 修饰类（其他分区照旧整页滚动）", () => {
    expect(settingsPageSource).toMatch(
      /section === "colorScheme"\s*\n?\s*\?\s*"settings-content settings-content--fill"/
    );
    // 修饰类必须来自分区判断，不能无条件加 —— 否则通用/终端/模型/
    // 快捷键分区也会被锁死成不滚动
    expect(settingsPageSource).toContain(
      '"settings-content"'
    );
  });

  it("fill 分区整体不滚动（外层 overflow 关掉）", () => {
    expect(
      ruleOf(".settings-content--fill"),
      ".settings-content--fill 没有 overflow-y:hidden —— 外层还是会滚"
    ).toContain("overflow-y: hidden");
  });

  it("配置卡与卡体在 fill 分区里放开收缩", () => {
    const row = ruleOf(
      ".settings-content--fill .settings-row"
    );
    expect(row).toContain("flex: 1");
    expect(
      row,
      "配置卡少了 min-height:0 —— 内容高度会把列表顶高"
    ).toContain("min-height: 0");

    const body = ruleOf(
      ".settings-content--fill .settings-row-body"
    );
    expect(body).toContain("flex: 1");
    expect(
      body,
      "卡体不是 flex 列或少了 min-height:0"
    ).toContain("flex-direction: column");
    expect(body).toContain("min-height: 0");
  });

  it("选择区是 flex 列且吃满剩余高度", () => {
    const picker = ruleOf(".scheme-picker");
    expect(picker).toContain("flex: 1");
    expect(picker).toContain(
      "flex-direction: column"
    );
    expect(
      picker,
      "选择区少了 min-height:0 —— 链路上最关键的一环"
    ).toContain("min-height: 0");
  });

  it("方案列表吃满剩余高度、内部滚动，不再写死 520px", () => {
    const list = ruleOf(".scheme-list");
    expect(list).toContain("flex: 1");
    expect(list).toContain("min-height: 0");
    expect(
      list,
      "列表不滚了 —— 追加批次靠 onScroll 触发，没了滚动就加载不完"
    ).toContain("overflow-y: auto");
    expect(
      list,
      "max-height 又写死了 —— 占不满屏，下方留空白"
    ).not.toContain("max-height: 520px");
  });

  it("预览 / tab / 搜索三件套是固定 chrome，不参与高度分配", () => {
    // 它们若跟着 flex 收缩，矮窗口下预览会被压扁。
    // ⚠️ 这三条是逗号组合选择器，ruleOf 那种「选择器紧跟 {」的取法
    // 抓不到（会抓到 .scheme-preview 自己的规则），直接钉整条组合规则。
    const rule =
      css.match(
        /\.scheme-preview\s*,\s*\.scheme-tabs\s*,\s*\.scheme-search\s*\{[^}]*\}/
      )?.[0] ?? "";
    expect(
      rule,
      "chrome 三件套没有 flex:none —— 矮窗口下会被压扁"
    ).toContain("flex: none");
  });
});
