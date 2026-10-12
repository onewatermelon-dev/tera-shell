import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";

/**
 * AI 助手回答的 markdown 排版（对齐 Codex CLI 的观感）。
 *
 * ## 根因：Streamdown 依赖的 shadcn 语义色，项目只定义了一半
 *
 * Streamdown 靠 tailwind 的 shadcn 原子类排版（`text-muted-foreground`、
 * `bg-sidebar`、`text-primary`、`bg-popover`、`bg-card`…）。HeroUI 只提供
 * 了一部分：已定义 `--foreground` `--background` `--muted` `--border`
 * `--accent`，而 `--muted-foreground` `--sidebar` `--primary`
 * `--popover` `--card` **一个都没有**。
 *
 * 缺变量不是「少个颜色」那么轻 —— 元素拿不到颜色就**退化成继承父级**
 * （通常是前景色），于是引用块/表格头/行内代码失去灰调、代码块没有
 * 边框底色、链接没有链接色。用户报的「样式很怪」就是这个。
 *
 * 为什么值得写测试：这类问题**纯视觉**，tsc / eslint / stylelint /
 * vitest / build 全绿，只有「编译真实 CSS 后检查那 5 个变量有没有定义」
 * 才看得出来。
 */

describe("AI 面板 markdown 排版", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /** 取 `.ai-panel` 规则块的内容。 */
  function panelRule(): string {
    const re =
      /(?:^|[},])\s*\.ai-panel\s*\{([^}]*)\}/g;
    return [...css.matchAll(re)]
      .map(m => m[1] ?? "")
      .join("\n");
  }

  it("补齐 Streamdown 依赖、而项目缺失的 5 个 shadcn 语义色", () => {
    const panel = panelRule();
    // ⚠️ 这五条缺一条，AI 回答就会退化一部分样式（见文件头注释）
    expect(
      panel,
      ".ai-panel 没补 --muted-foreground（引用块/表格头失去灰调）"
    ).toMatch(/--muted-foreground:/);
    expect(
      panel,
      ".ai-panel 没补 --sidebar（代码块/表格外框没底色）"
    ).toMatch(/--sidebar:/);
    expect(
      panel,
      ".ai-panel 没补 --primary（链接没有链接色）"
    ).toMatch(/--primary:/);
    expect(
      panel,
      ".ai-panel 没补 --popover（代码块工具条没底色）"
    ).toMatch(/--popover:/);
    expect(
      panel,
      ".ai-panel 没补 --card（代码块内层没底色）"
    ).toMatch(/--card:/);
  });

  it("补的别名指向项目已有令牌（不是写死颜色）", () => {
    const panel = panelRule();
    // ⚠️ 别写死色值 —— 那样换主题就失效了。项目已有：surface-secondary
    // /accent/foreground/muted/border
    for (const m of panel.matchAll(
      /--(?:muted-foreground|sidebar|popover|card|primary)\s*:\s*([^;]+);/g
    )) {
      const value = (m[1] ?? "").trim();
      expect(
        value,
        `${m[0]} 写死了值，应该指向 var(--*)`
      ).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it("作用域限定在 .ai-panel（不污染全局）", () => {
    // 补别名只对 Streamdown 有意义；挂到 :root 会连带改变全站
    // 同名变量的语义（比如 HeroUI 自己组件里的 --primary）
    const rootBlock =
      /(?:^|[},])\s*:root\s*\{([^}]*)\}/g;
    for (const m of css.matchAll(rootBlock)) {
      const block = m[1] ?? "";
      expect(
        block,
        "别名泄漏到了 :root —— 会影响全站同名变量"
      ).not.toMatch(
        /--(?:sidebar|popover|card)\s*:/
      );
    }
  });

  it("段落有间距（Codex 观感的核心）", () => {
    // Streamdown 默认段落无 margin，直接渲染会糊成一片
    expect(css).toMatch(
      /\.ai-entry\.is-assistant\s+p\s*\{/
    );
    expect(css).toMatch(
      /margin:\s*0\s+0\s+0\.7em/
    );
  });

  it("标题按侧栏宽度降档（不再用 3xl 撑破面板）", () => {
    const re =
      /\.ai-entry\.is-assistant\s+h1\s*\{[^}]*\}/g;
    const h1 = [...css.matchAll(re)]
      .map(m => m[0])
      .join("\n");
    expect(h1, "h1 没有降档").toMatch(
      /font-size:\s*1\.25em/
    );
    expect(h1).not.toContain("text-3xl");
  });

  it("列表缩进收窄（Streamdown 默认 pl-6=24px，窄面板太深）", () => {
    expect(css).toMatch(
      /padding-inline-start:\s*1\.35em/
    );
  });

  it("代码块有边框与横向滚动（窄面板必��）", () => {
    const re =
      /\.ai-entry\.is-assistant\s+pre\s*\{([^}]*)\}/g;
    const pre = [...css.matchAll(re)]
      .map(m => m[1] ?? "")
      .join("\n");
    expect(pre).toMatch(/border:/);
    expect(pre).toMatch(/overflow-x:\s*auto/);
  });
});
