/**
 * AI 回答的 markdown 渲染入口。
 *
 * 单独抽成组件是因为有**两处**要渲染（历史消息 + 流式输出），而下面
 * 四样东西每处都得一模一样，漏一处就会出现「有的回答有颜色、有的没有」
 * 这类前后不一致：
 *
 * ① `fillCodeFenceLanguage`：裸围栏补默认语言。模型漏标 ```bash 的信息串
 *    时左上角就没标签，同一段回答里「有的有、有的没有」。
 * ② `plugins.code`：语法高亮插件。不传的话 Streamdown 走兜底渲染，
 *    每个 token 的 color 都是 `inherit` = **整块一个颜色**。
 * ③ `mode`：流式那条必须显式 `streaming`，否则未闭合的围栏不会被解析。
 * ④ `sanitizeToolNames`：抹掉泄漏的工具内部标识（见 sanitize.ts）。
 */
import { useState } from "react";
import { Streamdown } from "streamdown";
import { fillCodeFenceLanguage } from "@/terminal/lib/codeFence";
import { createCodeHighlighter } from "@/terminal/lib/codeHighlight";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";

export function AiMarkdown({
  text,
  streaming = false
}: {
  text: string;
  streaming?: boolean;
}) {
  // ⚠️ 必须惰性创建且**只创建一次**：那是普通函数不是 hook，直接在
  // 渲染期调 `createCodeHighlighter()` 会每次渲染新建实例 → 内部
  // token 缓存全失效 → 每帧重新拆一遍 ANSI。用 useState 的惰性初值
  // 保证整个生命周期只有一个实例（也不能写模块级变量在渲染期赋值，
  // eslint react-hooks 会报「渲染期有副作用」）。
  const [highlighter] = useState(
    createCodeHighlighter
  );
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      plugins={{ code: highlighter }}
    >
      {/* 顺序要紧：先抹标识符再补围栏语言 —— 反过来的话，
          行内代码里被替换出的中文可能被误判成围栏信息串 */}
      {fillCodeFenceLanguage(
        sanitizeToolNames(text)
      )}
    </Streamdown>
  );
}
