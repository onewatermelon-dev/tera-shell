import { describe, it, expect } from "vitest";
import {
  ansiToTokens,
  createTokenSource,
  mergeThemedTokens,
  normalizeLanguage,
  truecolorToHex,
  MAX_HIGHLIGHT_BYTES,
  type HighlightToken
} from "@/terminal/lib/codeHighlight";

/**
 * AI 回答代码块的语法着色。
 *
 * ## 根因：不接高亮器就是整块一个颜色
 *
 * 早年 Streamdown 的 CodeBlock 有两条路：传了 `plugins.code`（Shiki
 * 插件）就按 token 上色，没传就走兜底渲染 —— 每个 token 的 `color`
 * 都是 `"inherit"`。所以「代码块没有颜色渲染」不是配色问题，是
 * **根本没接高亮器**。
 *
 * 2026-10-15：代码块外观换成 aicss 卡片（AiCodeBlock），高亮从
 * Streamdown 插件改成本文件的 `createTokenSource()`，着色管线
 * （ANSI → tokens）原样保留。
 *
 * ## 适配：cli-highlight 的 ANSI → tokens
 *
 * 本项目已有 `cli-highlight`（给终端 `cat` 着色用），但它输出的是 ANSI
 * 字符串，而渲染要 `tokens[][]`。中间这层转换是本文件唯一有难度的
 * 地方，所以拆成纯函数单独测 —— 高亮本体要真跑 Highlight.js，
 * node 环境下测不动。
 */
describe("代码块语法着色", () => {
  it("truecolor ANSI 参数 → #rrggbb", () => {
    expect(
      truecolorToHex("38;2;198;120;221")
    ).toBe("#c678dd");
    expect(truecolorToHex("38;2;0;0;0")).toBe(
      "#000000"
    );
    expect(
      truecolorToHex("38;2;255;255;255")
    ).toBe("#ffffff");
  });

  it("非 truecolor 参数返回 null（别硬转出错误颜色）", () => {
    expect(truecolorToHex("39")).toBeNull();
    expect(truecolorToHex("0")).toBeNull();
    expect(truecolorToHex("")).toBeNull();
    // 非 8 位真彩色（16 色模式）本项目不会产生，但要保证不炸
    expect(truecolorToHex("31")).toBeNull();
  });

  it("ANSI 文本 → 每行一组 token", () => {
    const tokens = ansiToTokens(
      "plain \x1b[38;2;198;120;221mif\x1b[39m done"
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual([
      { content: "plain ", color: undefined },
      { content: "if", color: "#c678dd" },
      { content: " done", color: undefined }
    ]);
  });

  it("换行切成多行（行号对齐靠这个）", () => {
    const tokens = ansiToTokens(
      "a\n\x1b[38;2;152;195;121mb\x1b[39m\nc"
    );
    expect(tokens).toHaveLength(3);
    expect(tokens[0]?.[0]?.content).toBe("a");
    expect(tokens[1]?.[0]).toEqual({
      content: "b",
      color: "#98c379"
    });
    expect(tokens[2]?.[0]?.content).toBe("c");
  });

  it("没有 ANSI 码时合成单个无色 token", () => {
    const tokens = ansiToTokens("hello");
    expect(tokens).toEqual([
      [{ content: "hello" }]
    ]);
  });

  it("空行也占一行（别让行号错位）", () => {
    const tokens = ansiToTokens("a\n\nb");
    expect(tokens).toHaveLength(3);
    expect(tokens[1]).toEqual([{ content: "" }]);
  });

  it("纯 ANSI 码没有可见字符时不产生空内容 token", () => {
    // 高亮器偶尔会吐出「只有转义没有内容」的片段
    const tokens = ansiToTokens(
      "\x1b[38;2;1;2;3m\x1b[39m"
    );
    expect(
      tokens[0]?.every(t => t.content === "")
    ).toBe(true);
  });

  it("内容里的方括号不该被当转义", () => {
    const tokens = ansiToTokens(
      "echo \x1b[38;2;152;195;121m[test]\x1b[39m"
    );
    expect(tokens[0]?.[1]?.content).toBe(
      "[test]"
    );
  });

  it("语言别名归一到 Highlight.js 的名字", () => {
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("shell")).toBe(
      "bash"
    );
    expect(normalizeLanguage("zsh")).toBe("bash");
    expect(normalizeLanguage("console")).toBe(
      "bash"
    );
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("py")).toBe(
      "python"
    );
    expect(normalizeLanguage("ts")).toBe(
      "typescript"
    );
    // 大写与空白要归一
    expect(normalizeLanguage(" JSON ")).toBe(
      "json"
    );
  });

  it("空/未知语言回落 plaintext（别让高亮器瞎猜）", () => {
    // ⚠️ 原样传给 cli-highlight 会走自动探测，bash 片段常被整段
    // 判成别的语言，颜色错得莫名其妙
    expect(normalizeLanguage("")).toBe(
      "plaintext"
    );
    expect(normalizeLanguage(null)).toBe(
      "plaintext"
    );
    expect(normalizeLanguage(undefined)).toBe(
      "plaintext"
    );
    expect(normalizeLanguage("   ")).toBe(
      "plaintext"
    );
  });

  it("面板两处渲染都走同一个组件（漏一处就「有的有颜色有的没有」）", async () => {
    // 2026-10-13：两处渲染随消息列表拆到 AiMessageList.tsx
    const src = (
      await import("@/terminal/components/ai/AiMessageList.tsx?raw")
    ).default;
    const uses = src.match(/<AiMarkdown/g) ?? [];
    expect(
      uses,
      "AiMessageList 里的 <AiMarkdown> 少于两处 —— 历史消息/流式有一处漏了"
    ).toHaveLength(2);
    // 别再直接用 Streamdown，否则那两处会丢掉围栏补语言和高亮插件
    expect(src).not.toContain("<Streamdown");
  });

  it("高亮源在组件里只创建一次", async () => {
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    // ⚠️ 每次渲染新建实例 → 内部 token 缓存全失效 → 每帧重拆 ANSI。
    // 也不能写模块级变量在渲染期赋值（eslint react-hooks 会报）
    expect(src).toMatch(
      /useState\(\s*createTokenSource\s*\)/
    );
    // 块级代码的外观入口确实接到了 AiCodeBlock（漏了就走 Streamdown
    // 自己那套 chrome，下载钮在 WebView2 里还是没反应）
    const md = (
      await import("@/terminal/components/ai/AiMarkdown.tsx?raw")
    ).default;
    expect(md).toContain("AiCodeBlock");
    expect(md).toContain("components=");
    // 行内代码的默认渲染被我们的覆盖替掉了，必须自己复刻样式
    expect(md).toContain(
      'data-streamdown="inline-code"'
    );
  });

  it("必须强制 chalk.level = 3（WebView 里没有真 TTY）", async () => {
    const src = (
      await import("@/terminal/lib/codeHighlight?raw")
    ).default;
    // 不设的话 chalk 自动降级 level=0 = 输出纯文本，一个 ANSI 码都没有
    expect(src).toMatch(/chalk\.level\s*=\s*3/);
    expect(MAX_HIGHLIGHT_BYTES).toBeGreaterThan(
      0
    );
  });

  /**
   * 明暗合并。
   *
   * Streamdown 给 token 的 class 是
   * `text-[var(--sdm-c)] dark:text-[var(--shiki-dark,var(--sdm-c))]`，
   * 且 `htmlStyle` 的任意 key 都会原样写成内联 CSS 变量。所以一套 token
   * 可以同时带两套配色 —— **不用在渲染期判断当前主题**，切主题也不用清缓存。
   */
  it("合并明暗两套色值到同一个 token", () => {
    const merged = mergeThemedTokens(
      [[{ content: "if", color: "#a626a4" }]],
      [[{ content: "if", color: "#c678dd" }]]
    );
    expect(merged).toEqual([
      [
        {
          content: "if",
          color: "#a626a4",
          htmlStyle: { "--shiki-dark": "#c678dd" }
        }
      ]
    ]);
  });

  it("两侧都无色时保持原样（不塞空的 htmlStyle）", () => {
    const merged = mergeThemedTokens(
      [[{ content: "x" }]],
      [[{ content: "x" }]]
    );
    expect(merged).toEqual([[{ content: "x" }]]);
  });

  it("分段对不上返回 null（宁可不染色也不能错位）", () => {
    expect(
      mergeThemedTokens(
        [[{ content: "a" }, { content: "b" }]],
        [[{ content: "a" }]]
      )
    ).toBeNull();
    expect(
      mergeThemedTokens([[{ content: "a" }]], [])
    ).toBeNull();
  });

  /**
   * 端到端：真跑一遍 cli-highlight，拿到渲染能用的 token。
   *
   * 前面那些都是「给定 ANSI 能否正确拆分」，这例反过来验证「给定 bash
   * 代码能否真的拆出带颜色的 token」—— 两头都对了，中间那层才成立。
   * 高亮源是动态 import，首调返回 null + 走 callback，这里等 callback。
   */
  it("端到端：bash 代码真的能拆出带颜色的 token", async () => {
    const source = createTokenSource();
    const code =
      'if [ -f /etc/passwd ]; then\n  echo "hi" # note\nfi';
    const run = () =>
      new Promise<HighlightToken[][] | null>(
        (resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error("高亮回调超时")),
            5000
          );
          const result = source.get(
            code,
            "bash",
            r => {
              clearTimeout(timer);
              resolve(r);
            }
          );
          if (result) {
            clearTimeout(timer);
            resolve(result);
          }
        }
      );
    const tokens = (await run()) ?? [];
    // 三行 → 三组
    expect(tokens).toHaveLength(3);
    // 必须真有颜色（不是全 undefined）—— 这才是「有颜色渲染」的判据
    const colors = tokens
      .flat()
      .map(t => t.color)
      .filter(Boolean);
    expect(
      colors.length,
      "拆出来的 token 一个颜色都没有 —— 高亮实际没生效"
    ).toBeGreaterThan(0);
    // 浅色主题走 One Light：关键字紫 #a626a4、注释灰 #a0a1a7。
    // ⚠️ 之前这里断言的是 One Dark 的 #c678dd —— 那是深色那套，
    // 亮绿亮紫配白底几乎看不清，正是要修的病。
    expect(colors).toContain("#a626a4");
    expect(colors).toContain("#a0a1a7");
    // 深色那套必须同时挂在 --shiki-dark 上（AiCodeBlock 深色模式读它）
    const darkColors = tokens
      .flat()
      .map(t => t.htmlStyle?.["--shiki-dark"])
      .filter(Boolean);
    expect(darkColors.length).toBeGreaterThan(0);
    expect(darkColors).toContain("#c678dd");
    expect(darkColors).toContain("#5c6370");
    // 文本内容必须一字不差地还原（高亮只加样式，不能改内容）
    expect(
      tokens.map(line =>
        line.map(t => t.content).join("")
      )
    ).toEqual(code.split("\n"));
  }, 10_000);

  it("超长代码跳过着色（逐字符拆 token 成本太高）", () => {
    const source = createTokenSource();
    const code = "x".repeat(
      MAX_HIGHLIGHT_BYTES + 1
    );
    const result = source.get(
      code,
      "bash",
      () => undefined
    );
    // 超长走同步路径：直接给无色结果，不排异步任务
    expect(result).not.toBeNull();
    expect(
      (result ?? []).flat().every(t => !t.color)
    ).toBe(true);
  });

  it("高亮失败退化成无色，不抛错", async () => {
    const source = createTokenSource();
    // 故意传一个 Highlight.js 不认的语言：不能整块代码块崩掉
    const tokens = await new Promise<
      HighlightToken[][] | null
    >(resolve => {
      const r = source.get(
        "随机内容",
        "绝对不存在的语言-xyz",
        resolve
      );
      if (r) resolve(r);
    });
    expect(tokens).not.toBeNull();
  });
});
