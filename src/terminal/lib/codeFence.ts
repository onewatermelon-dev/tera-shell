/**
 * AI 回答里的围栏代码块「补默认语言」。
 *
 * ## 为什么需要
 *
 * 代码块左上角那个语言标签直接来自 markdown 围栏的信息串（```bash 会显示
 * bash）。模型有时写 ` ```bash `、有时只写 ` ``` `，导致同一段回答里
 * **有的代码块有标签、有的没有**，右上角的下载按钮还会按语言决定文件名。
 * 系统提示词已经要求模型必须标语言，但那是「请求」不是「保证」——
 * 流式输出中途、模型偷懒、上下文长了都会漏，所以渲染前再兜一层。
 *
 * ## 规则（刻意保守）
 *
 * - 只碰**独占一行的围栏起始行**，行内代码、四反引号围栏、围栏内部的
 *   以 ``` 开头的内容都不动。
 * - 起始行后面**已经有任何非空白字符**（语言标注或 meta）就原样返回。
 * - **未闭合**的围栏也补：流式渲染时模型常常只吐到围栏首行，补上才能在
 *   后续几秒里就显示标签，而不是等整块结束才出现。
 *
 * 纯函数、不碰 DOM，才能单测（测试环境是 node，没有 DOM）。
 */

/** 代码块默认语言：这个助手跑在 SSH 服务器上，裸围栏基本就是 shell。 */
export const DEFAULT_CODE_LANGUAGE = "bash";

/** 围栏起始行：三个以上反引号（或波浪号），后面允许有语言标注。 */
const FENCE_LINE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * 给裸围栏补上默认语言。已经是 ```bash 的、以及围栏内部的 ``` 行，
 * 都原样保留。
 */
export function fillCodeFenceLanguage(
  markdown: string,
  defaultLanguage: string = DEFAULT_CODE_LANGUAGE
): string {
  if (!markdown) return markdown;
  let inFence = false;
  let fenceMarker = "";
  const lines = markdown.split("\n");
  const out = lines.map(line => {
    const m = FENCE_LINE.exec(line);
    if (!m) return line;
    const marker = m[2] ?? "";
    const info = (m[3] ?? "").trim();
    // 闭合围栏：info 通常为空，但它是「结束」不是「开始」，不能补语言
    if (inFence) {
      if (
        marker[0] === fenceMarker[0] &&
        marker.length >= fenceMarker.length
      ) {
        inFence = false;
        fenceMarker = "";
      }
      return line;
    }
    inFence = true;
    fenceMarker = marker;
    // 已经有语言标注（或 meta）→ 原样返回
    if (info) return line;
    const indent = m[1] ?? "";
    return `${indent}${marker}${defaultLanguage}`;
  });
  return out.join("\n");
}
