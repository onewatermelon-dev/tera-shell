import { describe, it, expect } from "vitest";

/**
 * AI 代码块外观（aicss CodeBlock 改造版）的接线断言。
 *
 * 为什么用源码断言：组件链上挂着 xterm / tauri / streamdown，node 环境
 * 里 import 不动（同 aiSelection.test.ts 的思路）。而这套改造最容易
 * 静默失效的点全是「接线」—— 外观接没接上、着色源建几次、另存为走
 * 哪条命令，恰好都能在源码上钉死。
 *
 * ⚠️ CSS 内容别用 `?raw` 读 `.module.css`：那条路会被 Vite 的 CSS
 * module 管线截走，拿到的是 Symbol 化的模块对象（2026-10-15 踩过）。
 * 改用 sass 直编文件拿文本 —— `:global(...)` Sass 当普通伪类透传，
 * 不影响断言（aiSelection.test.ts 同款思路）。
 */
describe("AI 代码块外观（aicss 改造版）", () => {
  /** 直编 CSS module 文件拿文本（?raw 在这类文件上不可用） */
  const compileCss = async (file: string) => {
    const sass = (await import("sass")).default;
    return sass.compile(file).css;
  };

  it("外观源自 @aicss 且保留了出处与改造说明", async () => {
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    // MIT 组件按项目惯例注明出处（同 PromptInput / ReasoningBlock）
    expect(src).toContain("@aicss/react");
    expect(src).toContain("MIT");
  });

  it("保留 aicss 的类名骨架（卡片/头/语言/复制/正文/行号）", async () => {
    const css = await compileCss(
      "src/terminal/components/ai/AiCodeBlock.module.css"
    );
    for (const cls of [
      ".cb {",
      ".cbHead {",
      ".cbLang {",
      ".cbCopy {",
      ".cbBody {",
      ".cbLn {"
    ]) {
      expect(
        css,
        `aicss 的类 ${cls} 没了 —— 外观就不是那回事了`
      ).toContain(cls);
    }
    // 行号列宽 32px 是 aicss 的栅格，分隔线画在它右缘
    expect(css).toContain(
      "grid-template-columns: 32px 1fr"
    );
  });

  it("着色 token 双主题：浅色 --sdm-c / 深色 --shiki-dark", async () => {
    const css = await compileCss(
      "src/terminal/components/ai/AiCodeBlock.module.css"
    );
    expect(css).toContain(".cbTok");
    // 三条主题分支与 aicss 主题块同款（data-theme / .dark / 系统偏好）。
    // ⚠️ sass 把 :global(...) 原样透传，断言要带着它
    expect(css).toContain(
      ':global([data-theme="dark"]) .cbTok'
    );
    expect(css).toContain(
      ":global(.dark) .cbTok"
    );
    expect(css).toContain(
      "prefers-color-scheme: dark"
    );
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    expect(src).toContain('"--sdm-c"');
    expect(src).toContain('"--shiki-dark"');
  });

  it("另存为走 fs_save_text_file + codeBlockFileName", async () => {
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    // WebView2 丢原生下载，必须走后端命令（见 streamdownExport.ts）
    expect(src).toContain("fs_save_text_file");
    expect(src).toContain("codeBlockFileName");
    // 失败必须留痕（现在走 logError：console + 落盘，见 shared/lib/log）
    expect(src).toContain("logError");
  });

  it("复制钮保留 aicss 行为（clipboard + 1.2s 复位）", async () => {
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    expect(src).toContain(
      "navigator.clipboard.writeText"
    );
    expect(src).toContain("1200");
  });

  it("复制/另存为纯图标，不挂文字也不挂气泡", async () => {
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    // 不要 Hint（HeroUI Tooltip）—— 用户明确不要气泡。
    // 只查 import 与用法：文档注释里提到「别加 Hint」是合理的
    expect(src).not.toContain(
      'from "@/shared/components/Hint"'
    );
    expect(src).not.toMatch(/<Hint/);
    // 行内文字 span 早已退休
    expect(src).not.toContain("cbCopyText");
    // ⚠️ title 也不能加：原生 title 也是气泡，且和 HeroUI 版会叠双提示
    expect(src).not.toMatch(/\stitle=/);
    // 可读性靠 aria-label 兜底（读屏软件），文案仍随状态走
    expect(src).toContain("aria-label=");
    expect(src).toContain('t("ai.code.copied")');
    expect(src).toContain(
      't("ai.code.saveFailed")'
    );
  });

  it("右侧按钮组推右上角：auto margin 挂左侧组", async () => {
    const css = await compileCss(
      "src/terminal/components/ai/AiCodeBlock.module.css"
    );
    // 推右的 auto margin 挂在 .cbFile（左侧组）上
    expect(css).toMatch(
      /\.cbFile \{[^}]*margin-right: auto/
    );
    // 按钮基类不带任何 auto margin（两个都挂会平分空间，见 10-15 记录）
    expect(css).not.toMatch(
      /\.cbCopy \{[^}]*margin-(left|right): auto/
    );
    // cbCopyLead 修饰类已废
    expect(css).not.toContain("cbCopyLead");
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    expect(src).not.toContain("cbCopyLead");
  });

  it("行号不参与划选（划词复制不带行号）", async () => {
    const css = await compileCss(
      "src/terminal/components/ai/AiCodeBlock.module.css"
    );
    // ⚠️ 必须双类 `.cb .cbLn`：_reset.scss 的 `.ai-panel *` 恢复可选
    // 规则是 (0,1,1)，单类 .cbLn (0,1,0) 盖不过 —— 行号会被原样
    // 复制出来（2026-10-15 踩过）。降 specificity  = 功能静默失效
    expect(css).toMatch(
      /\.cb \.cbLn \{[^}]*user-select: none/
    );
  });

  it("块级判定用 data-block，且不许覆盖 pre", async () => {
    const md = (
      await import("@/terminal/components/ai/AiMarkdown.tsx?raw")
    ).default;
    // Streamdown 只给块级代码打 data-block；行内走另一支
    expect(md).toContain('"data-block" in props');
    // 语言类名兜底：标记万一没注入，围栏代码也不该进行内分支
    expect(md).toContain("language-(");
    // 行内代码的默认渲染被覆盖替掉了，必须复刻样式，否则裸奔
    expect(md).toContain(
      'data-streamdown="inline-code"'
    );
    // ⚠️ 回归防线（2026-10-15）：pre 是 data-block 标记的注入点，
    // 覆盖它（哪怕透传）→ 标记丢失 → 块级代码全落进行内分支 →
    // 代码块「消失」。所以 components 里**不许出现 pre**
    expect(
      md,
      "又覆盖 pre 了 —— data-block 标记会丢，代码块会消失"
    ).not.toMatch(/\bpre:\s*[({]/);
  });

  it("代码块下载不再走 document 捕获 hack（按钮是自己的）", async () => {
    const src = (
      await import("@/terminal/components/ai/AiCodeBlock.tsx?raw")
    ).default;
    // 组件内直接 invoke，不依赖捕获链
    expect(src).not.toContain(
      "attachStreamdownExport"
    );
    // hack 里的代码块分支应已清掉（只剩表格）
    const exportSrc = (
      await import("@/terminal/lib/streamdownExport?raw")
    ).default;
    expect(exportSrc).not.toContain(
      "CODE_DOWNLOAD_SELECTOR"
    );
    expect(exportSrc).not.toContain(
      "readCodeBlock"
    );
  });
});
