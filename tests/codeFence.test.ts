import { describe, it, expect } from "vitest";
import {
  fillCodeFenceLanguage,
  DEFAULT_CODE_LANGUAGE
} from "@/terminal/lib/codeFence";
import { SYSTEM_PROMPT } from "@/terminal/lib/ai/aiChat";

/**
 * 裸围栏补默认语言。
 *
 * 代码块左上角的语言标签来自围栏信息串，模型漏标就没有 —— 表现为
 * 「同一段回答里有的代码块写着 bash、有的光秃秃」。提示词里已经要求
 * 必须标语言，但那是请求不是保证（流式中途、上下文长了都会漏），
 * 所以渲染前用这个纯函数兜一层。
 */
describe("代码块围栏补默认语言", () => {
  it("裸围栏补上默认语言", () => {
    const src = "说明：\n```\nls -al\n```";
    expect(fillCodeFenceLanguage(src)).toBe(
      `说明：\n\`\`\`${DEFAULT_CODE_LANGUAGE}\nls -al\n\`\`\``
    );
  });

  it("已有语言标注的原样保留（不重复追加）", () => {
    const src = "```bash\nls\n```";
    expect(fillCodeFenceLanguage(src)).toBe(src);
  });

  it("其它语言也保留", () => {
    for (const lang of [
      "json",
      "python",
      "sh",
      "console"
    ]) {
      const src = `\`\`\`${lang}\nx\n\`\`\``;
      expect(fillCodeFenceLanguage(src)).toBe(
        src
      );
    }
  });

  it("未闭合围栏也补（流式首帧就要出标签）", () => {
    // 流式过程中模型常只吐到围栏首行
    expect(
      fillCodeFenceLanguage("```\nls -")
    ).toBe(
      `\`\`\`${DEFAULT_CODE_LANGUAGE}\nls -`
    );
  });

  it("保留缩进（列表内的代码块）", () => {
    const src =
      "- 第一步\n\n  ```\n  cd /tmp\n  ```";
    expect(fillCodeFenceLanguage(src)).toBe(
      `- 第一步\n\n  \`\`\`${DEFAULT_CODE_LANGUAGE}\n  cd /tmp\n  \`\`\``
    );
  });

  it("围栏内部的 ``` 行不被当成新围栏", () => {
    // 嵌套围栏（markdown 文档里贴 shell 脚本）里的 ``` 是内容
    const src =
      "````markdown\n```bash\nx\n```\n````";
    expect(fillCodeFenceLanguage(src)).toBe(src);
  });

  it("波浪号围栏也能识别", () => {
    expect(
      fillCodeFenceLanguage("~~~\nx\n~~~")
    ).toBe(`~~~${DEFAULT_CODE_LANGUAGE}\nx\n~~~`);
  });

  it("行内代码不受影响", () => {
    const src =
      "用 `ls -al` 查看，``` 不是行内代码";
    expect(fillCodeFenceLanguage(src)).toBe(src);
  });

  it("没有代码块时原样返回（不新建数组语义外的改动）", () => {
    const src = "就是一段普通文字，没有围栏。";
    expect(fillCodeFenceLanguage(src)).toBe(src);
    expect(fillCodeFenceLanguage("")).toBe("");
  });

  it("可指定别的默认语言", () => {
    expect(
      fillCodeFenceLanguage("```\nx\n```", "text")
    ).toBe("```text\nx\n```");
  });

  it("系统提示词要求模型必须标语言（第一道防线）", () => {
    // ⚠️ 只有渲染层兜底不够：补出来的 bash 是猜的，语法高亮会认错语言。
    // 提示词这层是让模型自己写对，兜底只是防漏。
    expect(SYSTEM_PROMPT).toMatch(/语言标识/);
    expect(SYSTEM_PROMPT).toContain("bash");
  });
});
