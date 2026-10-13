/**
 * 三种 API 格式的请求构造、响应解析与流式累积。
 *
 * 从 aiChat.ts 拆出。内部流转统一为 OpenAI 消息形态（ProtocolMessage），
 * 适配器负责各家协议的双向转换；OpenAI Chat Completions、Anthropic
 * Messages、OpenAI Responses 各一个实现，按供应商的 apiFormat 选取。
 */
import type { ModelProvider } from "@/settings/lib/modelProviders";
import type { AiModelOption } from "./tools";
import type {
  ProtocolMessage,
  StreamAccumulator
} from "./protocol";

/** run_command 工具的 JSON Schema（三种格式通用）。 */
const RUN_COMMAND_PARAMETERS = {
  type: "object",
  properties: {
    command: { type: "string" },
    question: {
      type: "string",
      description: "向用户解释这条命令的用途"
    },
    is_read_only: {
      type: "boolean",
      description:
        "纯读取类命令为 true，会修改服务器状态必须为 false"
    }
  },
  required: [
    "command",
    "question",
    "is_read_only"
  ]
};

/** 模型的最大输出 Token：取模型配置，没填给 4096 兜底。 */
function maxTokensOf(
  option: AiModelOption
): number {
  return (
    Number(
      option.model.maxOutputTokens.replace(
        /,/g,
        ""
      )
    ) || 4096
  );
}

/** 三种 API 格式的请求构造与响应解析（内部流转统一为 OpenAI 消息形态）。 */
type FormatAdapter = {
  endpoint(baseUrl: string): string;
  headers(apiKey: string): Record<string, string>;
  buildBody(
    option: AiModelOption,
    messages: ProtocolMessage[]
  ): unknown;
  parse(text: string): ProtocolMessage;
};

const openAiAdapter: FormatAdapter = {
  endpoint: base => `${base}/chat/completions`,
  headers: apiKey => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  }),
  // reasoning_content 只用于展示：回传请求时剥离（DeepSeek 等不接受回传）
  buildBody: (option, messages) => ({
    model: option.model.name.trim(),
    messages: messages.map(
      ({
        reasoning: _reasoning,
        images,
        ...rest
      }) =>
        rest.role === "user" && images?.length
          ? {
              ...rest,
              content: [
                ...(rest.content
                  ? [
                      {
                        type: "text",
                        text: rest.content
                      }
                    ]
                  : []),
                ...images.map(url => ({
                  type: "image_url",
                  image_url: { url }
                }))
              ]
            }
          : rest
    ),
    max_tokens: maxTokensOf(option),
    tools: [
      {
        type: "function",
        function: {
          name: "run_command",
          description:
            "在当前 SSH 服务器上执行一条 shell 命令并返回输出",
          parameters: RUN_COMMAND_PARAMETERS
        }
      }
    ],
    tool_choice: "auto"
  }),
  parse: text => {
    const parsed = JSON.parse(text) as {
      choices?: {
        message?: ProtocolMessage & {
          reasoning_content?: string;
          reasoning?: string;
        };
      }[];
    };
    const message = parsed.choices?.[0]?.message;
    if (!message) {
      throw new Error("模型响应里没有消息内容");
    }
    return {
      ...message,
      reasoning:
        message.reasoning_content ??
        message.reasoning
    };
  }
};

/** data URL → Anthropic base64 图片块；解析不出 MIME 时按 png 兜底。 */
function anthropicImageBlock(dataUrl: string): {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
} {
  const matched =
    /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: matched?.[1] ?? "image/png",
      data: matched?.[2] ?? ""
    }
  };
}

/** Anthropic Messages：system 顶层、tool_use/tool_result 块、结果必须并进下一条 user 消息。 */
export const anthropicAdapter: FormatAdapter = {
  endpoint: base => `${base}/v1/messages`,
  headers: apiKey => ({
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  }),
  buildBody: (option, messages) => {
    // system 只有一条且在最前（引擎保证），拆出来放顶层字段
    const system =
      messages[0]?.role === "system"
        ? (messages[0].content ?? "")
        : "";
    const rest =
      messages[0]?.role === "system"
        ? messages.slice(1)
        : messages;
    const converted: Array<
      | { role: "user"; content: unknown }
      | { role: "assistant"; content: unknown }
    > = [];
    for (const message of rest) {
      if (message.role === "tool") {
        // 连续的 tool 结果必须合并进**同一条** user 消息的 tool_result 块
        const last =
          converted[converted.length - 1];
        const block = {
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: message.content ?? ""
        };
        if (
          last?.role === "user" &&
          Array.isArray(last.content)
        ) {
          (last.content as unknown[]).push(block);
        } else {
          converted.push({
            role: "user",
            content: [block]
          });
        }
        continue;
      }
      if (message.role === "assistant") {
        const blocks: unknown[] = [];
        if (message.content) {
          blocks.push({
            type: "text",
            text: message.content
          });
        }
        for (const call of message.tool_calls ??
          []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: JSON.parse(
              call.function.arguments || "{}"
            )
          });
        }
        converted.push({
          role: "assistant",
          content: blocks
        });
        continue;
      }
      converted.push({
        role: "user",
        content: message.images?.length
          ? [
              {
                type: "text",
                text: message.content ?? ""
              },
              ...message.images.map(
                anthropicImageBlock
              )
            ]
          : (message.content ?? "")
      });
    }
    return {
      model: option.model.name.trim(),
      max_tokens: maxTokensOf(option),
      system,
      messages: converted,
      tools: [
        {
          name: "run_command",
          description:
            "在当前 SSH 服务器上执行一条 shell 命令并返回输出",
          input_schema: RUN_COMMAND_PARAMETERS
        }
      ],
      tool_choice: { type: "auto" }
    };
  },
  parse: text => {
    const parsed = JSON.parse(text) as {
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
    };
    const content = (parsed.content ?? [])
      .filter(block => block.type === "text")
      .map(block => block.text ?? "")
      .join("");
    // 思考块只用于展示，回传时不带（缺签名会被服务端拒绝）
    const reasoning = (parsed.content ?? [])
      .filter(block => block.type === "thinking")
      .map(block => block.thinking ?? "")
      .join("\n\n");
    const toolCalls = (parsed.content ?? [])
      .filter(block => block.type === "tool_use")
      .map(block => ({
        id: block.id ?? "",
        type: "function" as const,
        function: {
          name: block.name ?? "",
          arguments: JSON.stringify(
            block.input ?? {}
          )
        }
      }));
    if (!content && toolCalls.length === 0) {
      throw new Error("模型响应里没有消息内容");
    }
    return {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length
        ? { tool_calls: toolCalls }
        : {})
    };
  }
};

/** OpenAI Responses：system 走 instructions，函数调用是顶层 output 项。 */
export const responsesAdapter: FormatAdapter = {
  endpoint: base => `${base}/responses`,
  headers: apiKey => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  }),
  buildBody: (option, messages) => {
    const system =
      messages[0]?.role === "system"
        ? (messages[0].content ?? "")
        : "";
    const rest =
      messages[0]?.role === "system"
        ? messages.slice(1)
        : messages;
    const input: unknown[] = [];
    for (const message of rest) {
      if (message.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id ?? "",
          output: message.content ?? ""
        });
        continue;
      }
      if (message.role === "assistant") {
        if (message.content) {
          input.push({
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: message.content
              }
            ]
          });
        }
        for (const call of message.tool_calls ??
          []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments
          });
        }
        continue;
      }
      input.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: message.content ?? ""
          },
          // Responses 接受 data URL 作为 input_image 的 image_url
          ...(message.images ?? []).map(url => ({
            type: "input_image",
            image_url: url
          }))
        ]
      });
    }
    return {
      model: option.model.name.trim(),
      max_output_tokens: maxTokensOf(option),
      instructions: system,
      input,
      tools: [
        {
          type: "function",
          name: "run_command",
          description:
            "在当前 SSH 服务器上执行一条 shell 命令并返回输出",
          parameters: RUN_COMMAND_PARAMETERS
        }
      ],
      tool_choice: "auto"
    };
  },
  parse: text => {
    const parsed = JSON.parse(text) as {
      output?: Array<{
        type: string;
        text?: string;
        content?: Array<{
          type: string;
          text?: string;
        }>;
        summary?: Array<{
          type: string;
          text?: string;
        }>;
        call_id?: string;
        name?: string;
        arguments?: string;
      }>;
    };
    const content = (parsed.output ?? [])
      .filter(item => item.type === "message")
      .flatMap(item => item.content ?? [])
      .filter(part => part.type === "output_text")
      .map(part => part.text ?? "")
      .join("");
    // reasoning 项的摘要只用于展示，回传时不带
    const reasoning = (parsed.output ?? [])
      .filter(item => item.type === "reasoning")
      .flatMap(item => item.summary ?? [])
      .filter(
        part => part.type === "summary_text"
      )
      .map(part => part.text ?? "")
      .join("\n\n");
    const toolCalls = (parsed.output ?? [])
      .filter(
        item => item.type === "function_call"
      )
      .map(item => ({
        id: item.call_id ?? "",
        type: "function" as const,
        function: {
          name: item.name ?? "",
          arguments: item.arguments ?? "{}"
        }
      }));
    if (!content && toolCalls.length === 0) {
      throw new Error("模型响应里没有消息内容");
    }
    return {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length
        ? { tool_calls: toolCalls }
        : {})
    };
  }
};

function adapterOf(
  format: ModelProvider["apiFormat"]
): FormatAdapter {
  if (format === "anthropic")
    return anthropicAdapter;
  if (format === "responses")
    return responsesAdapter;
  return openAiAdapter;
}

/** OpenAI 流：delta.content / delta.reasoning_content / delta.tool_calls 按分片累加。 */
function openAiAccumulator(): StreamAccumulator {
  let content = "";
  let reasoning = "";
  const tools = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  return {
    feed: payload => {
      if (payload === "[DONE]") return {};
      const chunk = JSON.parse(payload) as {
        choices?: {
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: {
                name?: string;
                arguments?: string;
              };
            }[];
          };
        }[];
      };
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return {};
      content += delta.content ?? "";
      reasoning +=
        delta.reasoning_content ??
        delta.reasoning ??
        "";
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const held = tools.get(index) ?? {
          id: "",
          name: "",
          args: ""
        };
        held.id = held.id || call.id || "";
        held.name =
          held.name || call.function?.name || "";
        held.args +=
          call.function?.arguments ?? "";
        tools.set(index, held);
      }
      return {
        content: delta.content,
        reasoning:
          delta.reasoning_content ??
          delta.reasoning
      };
    },
    finalize: () => {
      const toolCalls = [...tools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, tool]) => ({
          id: tool.id || `call_${index}`,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: tool.args || "{}"
          }
        }));
      if (
        !content &&
        !reasoning &&
        toolCalls.length === 0
      ) {
        throw new Error("模型响应里没有消息内容");
      }
      return {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length
          ? { tool_calls: toolCalls }
          : {})
      };
    }
  };
}

/** Anthropic 流：content_block_start/delta 按 index 归属，tool_use 的参数经 input_json_delta 分片。 */
function anthropicAccumulator(): StreamAccumulator {
  let text = "";
  let thinking = "";
  const tools = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  return {
    feed: payload => {
      const event = JSON.parse(payload) as {
        type: string;
        index?: number;
        content_block?: {
          type: string;
          id?: string;
          name?: string;
        };
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        };
      };
      if (event.type === "content_block_start") {
        // tool_use 块开始时登记 id / name；text 与 thinking 走 delta
        if (
          event.content_block?.type === "tool_use"
        ) {
          const index = event.index ?? 0;
          tools.set(index, {
            id: event.content_block.id ?? "",
            name: event.content_block.name ?? "",
            args: ""
          });
        }
        return {};
      }
      if (event.type !== "content_block_delta")
        return {};
      const index = event.index ?? 0;
      if (event.delta?.type === "text_delta") {
        text += event.delta.text ?? "";
        return { content: event.delta.text };
      }
      if (
        event.delta?.type === "thinking_delta"
      ) {
        thinking += event.delta.thinking ?? "";
        return {
          reasoning: event.delta.thinking
        };
      }
      if (
        event.delta?.type === "input_json_delta"
      ) {
        const tool = tools.get(index);
        if (tool)
          tool.args +=
            event.delta.partial_json ?? "";
      }
      return {};
    },
    finalize: () => {
      const toolCalls = [...tools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, tool]) => ({
          id: tool.id || `toolu_${index}`,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: tool.args || "{}"
          }
        }));
      if (
        !text &&
        !thinking &&
        toolCalls.length === 0
      ) {
        throw new Error("模型响应里没有消息内容");
      }
      return {
        role: "assistant",
        content: text || null,
        ...(thinking
          ? { reasoning: thinking }
          : {}),
        ...(toolCalls.length
          ? { tool_calls: toolCalls }
          : {})
      };
    }
  };
}

/** Responses 流：文本/摘要走 delta 事件，函数调用按 item_id 归并，completed 事件只做信号。 */
function responsesAccumulator(): StreamAccumulator {
  let content = "";
  let reasoning = "";
  const calls = new Map<
    string,
    { callId: string; name: string; args: string }
  >();
  return {
    feed: payload => {
      const event = JSON.parse(payload) as {
        type: string;
        delta?: string;
        item?: {
          type?: string;
          id?: string;
          call_id?: string;
          name?: string;
        };
        item_id?: string;
      };
      if (
        event.type ===
        "response.output_text.delta"
      ) {
        content += event.delta ?? "";
        return { content: event.delta };
      }
      if (
        event.type ===
        "response.reasoning_summary_text.delta"
      ) {
        reasoning += event.delta ?? "";
        return { reasoning: event.delta };
      }
      if (
        event.type ===
          "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        const itemId = event.item.id ?? "";
        calls.set(itemId, {
          callId: event.item.call_id ?? itemId,
          name: event.item.name ?? "",
          args: ""
        });
        return {};
      }
      if (
        event.type ===
        "response.function_call_arguments.delta"
      ) {
        const call = calls.get(
          event.item_id ?? ""
        );
        if (call) call.args += event.delta ?? "";
      }
      return {};
    },
    finalize: () => {
      const toolCalls = [...calls.values()].map(
        call => ({
          id: call.callId,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: call.args || "{}"
          }
        })
      );
      if (
        !content &&
        !reasoning &&
        toolCalls.length === 0
      ) {
        throw new Error("模型响应里没有消息内容");
      }
      return {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length
          ? { tool_calls: toolCalls }
          : {})
      };
    }
  };
}

function accumulatorOf(
  format: ModelProvider["apiFormat"]
): StreamAccumulator {
  if (format === "anthropic")
    return anthropicAccumulator();
  if (format === "responses")
    return responsesAccumulator();
  return openAiAccumulator();
}

export {
  adapterOf,
  accumulatorOf,
  type FormatAdapter
};
