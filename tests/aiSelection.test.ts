import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";
// ?raw 读源码：整个 AiPanel 的依赖链太长（xterm/tauri/streamdown），
// 单测里 import 组件会连带把它们全加载
import aiPanelSource from "@/terminal/components/AiPanel.tsx?raw";
import queueRowSource from "@/terminal/components/aicss/QueuedMessageRow.tsx?raw";

/**
 * AI 助手面板的文字要能划词复制。
 *
 * 背景：项目全局 `user-select: none`（桌面应用里拖选界面文字没意义，
 * 还会干扰拖拽），只有终端子树与输入控件恢复了 `text`。AI 面板后来加了
 * `.ai-panel` 到白名单，但**从未验证过** —— 用户报「AI 助手中的文字需要
 * 能够划词复制」时才确认它没真的生效。
 *
 * 为什么单测能抓：这类问题纯视觉、tsc/eslint/stylelint 全绿，
 * 只有编译真实 sass 后检查「恢复可选的规则里到底列了哪些选择器」才看得出。
 */

describe("AI 面板文字可划词复制", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /** 从整份 CSS 里找出「包含某选择器且声明了 user-select」的块。 */
  function ruleDeclaring(
    selector: string
  ): string {
    const re = new RegExp(
      `(?:^|[},])\\s*([^{}]*${selector}[^{}]*)\\{([^}]*user-select[^}]*)\\}`,
      "g"
    );
    return [...css.matchAll(re)]
      .map(m => m[2] ?? "")
      .join("\n");
  }

  it("全局仍禁止划词（这条不能被顺手删掉）", () => {
    // 桌面应用的默认行为：界面文字不可拖选，否则拖拽手柄会被误选
    const global = ruleDeclaring("\\\\*");
    expect(
      global,
      "全局 user-select:none 没了 —— 拖拽会变得很难用"
    ).toContain("user-select: none");
  });

  it("AI 面板整棵子树恢复可选", () => {
    const rule = ruleDeclaring("\\.ai-panel");
    expect(
      rule,
      ".ai-panel 没有恢复 user-select"
    ).toContain("user-select: text");
  });

  it("白名单里的每个选择器都真的存在类名（防止写了空规则）", () => {
    // ⚠️ 这一条是本次的核心：`.ai-panel` 曾长期写在这条规则里，
    // 但一度与组件实际类名脱节（组件里叫别的名字），规则空转、
    // 全局 none 照旧生效 —— 从 CSS 上完全看不出问题。
    // 所以「规则里列的选择器」必须能在源码里找到同名类。
    const rule = ruleDeclaring("\\.ai-panel");
    expect(rule).toContain("user-select: text");

    // 用源码反查：AiPanel 的根节点必须是 .ai-panel
    // （?raw 读源码，避免整个组件的依赖被拉进来）
    expect(aiPanelSource).toContain(
      'className="ai-panel"'
    );
  });

  it("对话区容器在 .ai-panel 之内（否则恢复可选覆盖不到）", () => {
    // .ai-panel-body 是消息列表的滚动容器；它必须挂在 .ai-panel 子树里
    expect(aiPanelSource).toContain(
      'className="ai-panel-body"'
    );
  });

  it("拖拽浮标不可选（那是跟手指示器，不是内容）", () => {
    // .ai-reopen-tab 是收起浮窗的拖拽手柄，划词会把手柄文字选蓝、
    // 反过来干扰拖拽定位 —— 必须保持 none
    expect(
      ruleDeclaring("\\.ai-reopen-tab"),
      ".ai-reopen-tab 被 .ai-panel * 的 text 覆盖了"
    ).toContain("user-select: none");
  });

  it("队列里的消息文字可选（它是内容，不是手柄）", () => {
    // .ai-queue-text 是排队中用户自己发的那句话 —— 内容，该能划词。
    // ⚠️ 别误加 user-select:none（记忆里踩过「全局 none」的坑）：
    // 用户能看到的话就该能复制，否则只能重发一遍。
    expect(queueRowSource).toContain(
      'className="ai-queue-text"'
    );
  });

  it("终端子树仍然可选（别被这次改动误伤）", () => {
    expect(
      ruleDeclaring("\\.terminal-host")
    ).toContain("user-select: text");
  });
});
