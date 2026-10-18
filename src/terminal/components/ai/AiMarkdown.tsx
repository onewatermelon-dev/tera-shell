"use client";

/**
 * AI 回答的 markdown 渲染入口。
 *
 * 单独抽成组件是因为有**两处**要渲染（历史消息 + 流式输出），而下面
 * 几样东西每处都得一模一样，漏一处就会出现「有的回答有颜色、有的没有」
 * 这类前后不一致：
 *
 * ① `fillCodeFenceLanguage`：裸围栏补默认语言。模型漏标 ```bash 的信息串
 *    时左上角就没标签，同一段回答里「有的有、有的没有」。
 * ② `components.code`：块级代码的外观整体交给 AiCodeBlock（aicss 卡片
 *    + 本项目着色 + 另存为）。不覆盖的话 Streamdown 走自己那套 chrome
 *    —— 它的下载钮在 WebView2 里点了还没反应。
 * ③ `mode`：流式那条必须显式 `streaming`，否则未闭合的围栏不会被解析。
 * ④ `sanitizeToolNames`：抹掉泄漏的工具内部标识（见 sanitize.ts）。
 *
 * ⚠️ **不要覆盖 `pre`**（2026-10-15 踩过）：Streamdown 内部的 pre 组件
 * 负责给块级 code 元素注入 `data-block` 标记（cloneElement），那是块级
 * 与行内唯一的判据。拿透传的 pre 把它替掉 → 标记丢失 → 所有块级代码
 * 落进行内分支 → 代码块「消失」（变成一个行内小 chip）。而且它本来就会
 * 把 pre 外壳拆掉只留 code 元素，**根本不会有双 chrome**，没有覆盖的
 * 必要。
 *
 * ⚠️ 行内代码也要在这里接：`components.code` 一覆盖，Streamdown 默认的
 * 行内渲染（`data-streamdown="inline-code"` 那套样式）随之退场，得自己
 * 复刻，否则行内代码会裸奔。
 */

import { useMemo } from "react";
import {
  Streamdown,
  type Components
} from "streamdown";
import { fillCodeFenceLanguage } from "@/terminal/lib/codeFence";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import { parseMetricChart } from "@/terminal/lib/ai/metricChart";
import { parseTopologyChart } from "@/terminal/lib/ai/topology";
import { parseStructuredTable } from "@/terminal/lib/ai/structuredTable";
import { AiCodeBlock } from "./AiCodeBlock";
import { AiMetricChart } from "./AiMetricChart";
import { AiTopologyGraph } from "./AiTopologyGraph";
import { AiStructuredTable } from "./AiStructuredTable";

/** 图表围栏块的语言标识（见 metricChart.ts 的格式说明） */
const CHART_LANG = "metric-chart";
/** 结构化表格围栏块的语言标识（见 structuredTable.ts） */
const TABLE_LANG = "data-table";

/** 代码元素的 props（Streamdown 给块级代码打了 `data-block` 标记） */
type CodeProps = {
  className?: string;
  children?: unknown;
};

/** 行内代码：复刻 Streamdown 默认行内样式（我们的覆盖把默认那套替掉了） */
function InlineCode({ children }: CodeProps) {
  return (
    <code
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
      data-streamdown="inline-code"
    >
      {children as string}
    </code>
  );
}

export function AiMarkdown({
  text,
  streaming = false
}: {
  text: string;
  streaming?: boolean;
}) {
  // ⚠️ useMemo 钉住：函数组件每次渲染新建会让 Streamdown 重挂整棵
  // 子树，流式期间每帧都重挂一次，输入都受影响。
  // ⚠️ 只覆盖 code，**别动 pre** —— 见文件头：data-block 标记是
  // Streamdown 的 pre 注入的，覆盖它等于判据丢了（块级代码全变行内）。
  const components = useMemo<Components>(
    () => ({
      code: props => {
        const match = /language-(\S+)/.exec(
          props.className ?? ""
        );
        // 块级判据：data-block 标记（Streamdown 的 pre 注入的）；
        // 语言类名兜底 —— 万一标记没注入，围栏代码也不该进行内分支
        if (!("data-block" in props) && !match)
          return <InlineCode {...props} />;
        const code = String(
          props.children ?? ""
        ).replace(/\n$/, "");
        const lang = match?.[1] ?? "text";
        // 指标图表：模型按提示词用 ```metric-chart 输出监控数据。
        // 解析失败（流式期间 JSON 没闭合、或格式坏）就回落成普通代码块
        // —— 用户至少能看到原始数据，不会白屏。
        if (lang === CHART_LANG) {
          const spec = parseMetricChart(code);
          if (spec)
            return <AiMetricChart spec={spec} />;
          // 同一围栏块的另一种形态：type=graph 走拓扑图
          const graph = parseTopologyChart(code);
          if (graph)
            return (
              <AiTopologyGraph spec={graph} />
            );
        }
        // 结构化表格：同一套路子，解析失败回落代码块
        if (lang === TABLE_LANG) {
          const spec = parseStructuredTable(code);
          if (spec)
            return (
              <AiStructuredTable spec={spec} />
            );
        }
        return (
          <AiCodeBlock lang={lang} code={code} />
        );
      }
    }),
    []
  );
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      components={components}
    >
      {/* 顺序要紧：先抹标识符再补围栏语言 —— 反过来的话，
          行内代码里被替换出的中文可能被误判成围栏信息串 */}
      {fillCodeFenceLanguage(
        sanitizeToolNames(text)
      )}
    </Streamdown>
  );
}
