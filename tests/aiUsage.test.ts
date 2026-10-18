import { describe, it, expect } from "vitest";

import { accumulatorOf } from "@/terminal/lib/ai/adapters";
import { formatTokens } from "@/terminal/lib/ai/usageFormat";

describe("token 格式化", () => {
  it("千分位", () => {
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1_234_567)).toBe(
      "1,234,567"
    );
  });
});

describe("三家 API 的 usage 提取", () => {
  it("OpenAI：usage 在最后一个 chunk（无 choices）", () => {
    const accumulator = accumulatorOf("openai");
    accumulator.feed(
      JSON.stringify({
        choices: [{ delta: { content: "你好" } }]
      })
    );
    // 用量 chunk 没有 choices，别被当成空 delta 吞掉
    accumulator.feed(
      JSON.stringify({
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          prompt_tokens_details: {
            cached_tokens: 1024
          }
        }
      })
    );
    expect(accumulator.usage()).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cachedInputTokens: 1024
    });
    // 消息本体不受影响
    expect(accumulator.finalize().content).toBe(
      "你好"
    );
  });

  it("OpenAI：没给 usage 就 undefined", () => {
    const accumulator = accumulatorOf("openai");
    accumulator.feed(
      JSON.stringify({
        choices: [{ delta: { content: "hi" } }]
      })
    );
    expect(accumulator.usage()).toBeUndefined();
  });

  it("Anthropic：message_start 给输入、message_delta 给输出", () => {
    const accumulator =
      accumulatorOf("anthropic");
    accumulator.feed(
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 500,
            output_tokens: 0,
            cache_read_input_tokens: 300
          }
        }
      })
    );
    accumulator.feed(
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 220 }
      })
    );
    expect(accumulator.usage()).toEqual({
      inputTokens: 500,
      outputTokens: 220,
      cachedInputTokens: 300
    });
  });

  it("Anthropic：只有 message_delta（没有 start）时 output 丢弃", () => {
    const accumulator =
      accumulatorOf("anthropic");
    accumulator.feed(
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 220 }
      })
    );
    expect(accumulator.usage()).toBeUndefined();
  });

  it("Responses：response.completed 带 usage", () => {
    const accumulator =
      accumulatorOf("responses");
    accumulator.feed(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "ok"
      })
    );
    accumulator.feed(
      JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 900,
            output_tokens: 45,
            input_tokens_details: {
              cached_tokens: 512
            }
          }
        }
      })
    );
    expect(accumulator.usage()).toEqual({
      inputTokens: 900,
      outputTokens: 45,
      cachedInputTokens: 512
    });
  });
});

describe("用量可见性的接线（防静默失效）", () => {
  it("OpenAI 系请求体带 stream_options.include_usage", async () => {
    const src = (
      await import("@/terminal/lib/ai/stream.ts?raw")
    ).default;
    expect(src).toContain("include_usage");
    // 只给 openai 格式加：另两家不认这个字段
    expect(src).toContain(
      'apiFormat === "openai"'
    );
  });

  it("usage 挂进 assistant 条目（含工具跳结转）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(src).toContain("carriedUsage");
    expect(src).toContain("usage: entryUsage");
  });

  it("用量并进消息操作行（复制 / 时间前面），无独立徽标行", async () => {
    const list = (
      await import("@/terminal/components/ai/AiMessageList.tsx?raw")
    ).default;
    // usage 作为 props 传给操作行
    expect(list).toContain("usage={entry.usage}");
    // 独立徽标组件已删除，别再回潮
    expect(list).not.toContain("UsageBadge");
    expect(
      Object.keys(
        import.meta.glob(
          "../src/terminal/components/ai/UsageBadge.tsx"
        )
      )
    ).toHaveLength(0);

    const panel = (
      await import("@/terminal/components/ai/AiPanel.tsx?raw")
    ).default;
    // 会话总 token 已从标题右侧撤掉（用户要求）
    expect(panel).not.toContain(
      "ai-panel-head-usage"
    );
    expect(panel).not.toContain("sessionUsage");
  });

  it("操作行用量：图标 + 文字，不用上下箭头", async () => {
    const src = (
      await import("@/terminal/components/ai/ChatMessageActions.tsx?raw")
    ).default;
    // 三个非箭头图标
    expect(src).toContain("InboxOutlined");
    expect(src).toContain("CommentOutlined");
    expect(src).toContain("HistoryOutlined");
    // 文字标签（输入 / 输出 / 缓存）
    expect(src).toContain("ai.usage.input");
    expect(src).toContain("ai.usage.output");
    expect(src).toContain("ai.usage.cached");
    // 不再用箭头符号
    expect(src).not.toContain("↓");
    expect(src).not.toContain("↑");
    // 带用量时这一行常驻可见（不藏在悬停里）
    expect(src).toContain("data-has-usage");
  });

  it("只显示 token，不显示成本（价格已撤）", async () => {
    const actions = (
      await import("@/terminal/components/ai/ChatMessageActions.tsx?raw")
    ).default;
    expect(actions).not.toContain("modelPricing");
    expect(actions).not.toContain("¥");

    const panel = (
      await import("@/terminal/components/ai/AiPanel.tsx?raw")
    ).default;
    expect(panel).not.toContain("estimateCost");
    expect(panel).not.toContain("formatCost");

    // 价格模块已删除（只留 token 展示）：glob 匹配不到即视为不存在
    expect(
      Object.keys(
        import.meta.glob(
          "../src/terminal/lib/ai/modelPricing.ts"
        )
      )
    ).toHaveLength(0);
  });
});
