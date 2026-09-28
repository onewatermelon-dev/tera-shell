import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import {
  loadProviders,
  type ModelEntry,
  type ModelProvider
} from "@/settings/lib/modelProviders";
import {
  saveHistory,
  type AiHistory
} from "@/terminal/lib/aiHistory";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

/** 执行卡片上命令的执行方式：terminal = 写入活动会话终端；background = 独立 exec 通道。 */
export type ExecCardMode =
  "terminal" | "background";

/** 读 xterm 缓冲区的最后 N 行（去掉尾部空行），用于收集终端执行的输出。 */
function terminalTail(
  terminal: Terminal | undefined,
  lines: number
): string {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  const out: string[] = [];
  const start = Math.max(
    0,
    buffer.length - lines
  );
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      out.push(line.translateToString(true));
    }
  }
  while (
    out.length &&
    !out[out.length - 1]?.trim()
  ) {
    out.pop();
  }
  return out.join("\n");
}

/**
 * AI 聊天的交互引擎：workspace 上下文注入 + run_command 工具循环。
 *
 * 借鉴 WisdomSSH 的交互模型 —— 模型通过 run_command 工具在当前服务器
 * 执行命令；「自动执行 / 自动应用」开关决定卡片自动执行还是等用户确认。
 * 会话只保存在内存里（应用关闭即消失），不落盘。
 */

/** 一条用户 / 助手可见消息。 */
export type AiChatEntry =
  | {
      kind: "user";
      text: string;
      /** 用户上传的图片（data URL），仅展示用 */
      images?: string[];
    }
  | {
      kind: "assistant";
      text: string;
      /** 思考内容（有才显示 ReasoningBlock） */
      reasoning?: string;
      /** 思考耗时（秒） */
      elapsedSeconds?: number;
    }
  | { kind: "tool"; call: AiToolCall };

/** 一次命令执行卡片的状态。 */
export type AiToolCall = {
  id: string;
  command: string;
  /** 模型给出的执行说明，展示给用户 */
  question: string;
  /** true = 只读（受「自动执行」开关控制）；false = 读写（受「自动应用」开关控制） */
  isReadOnly: boolean;
  /** pending=等确认，running=执行中，done/failed=已结束 */
  state:
    "pending" | "running" | "done" | "failed";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** 执行失败 / 被跳过的原因（仅 UI 展示） */
  error?: string;
};

/** OpenAI Chat Completions 协议消息（引擎内部流转用）。 */
export type ProtocolMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  /** 模型的思考内容：仅供展示，回传请求时必须剥离（见 buildBody） */
  reasoning?: string;
  /** 用户上传的图片（data URL），仅 user 消息携带，适配器转多模态块 */
  images?: string[];
};

/** 可选中的模型：供应商 × 模型。 */
export type AiModelOption = {
  providerId: string;
  modelId: string;
  /** 下拉展示文本：供应商 / 模型 */
  label: string;
  provider: ModelProvider;
  model: ModelEntry;
};

/** 列出可用的聊天模型：三种 API 格式都支持（面板下拉数据源）。 */
export function listOpenAiModels(): AiModelOption[] {
  return loadProviders()
    .filter(p => p.enabled)
    .flatMap(provider =>
      provider.models
        .filter(m => m.enabled && m.name.trim())
        .map(model => ({
          providerId: provider.id,
          modelId: model.id,
          label: `${provider.name} / ${model.name}`,
          provider,
          model
        }))
    );
}

const MODEL_STORAGE_KEY = "ai-selected-model";

/** 上次选中的模型（providerId::modelId），跨启动记住。 */
export function loadSelectedModel():
  string | null {
  try {
    return localStorage.getItem(
      MODEL_STORAGE_KEY
    );
  } catch {
    return null;
  }
}

/** 上次选中的模型（providerId::modelId），跨启动记住。 */
export function saveSelectedModel(
  value: string
): void {
  try {
    localStorage.setItem(
      MODEL_STORAGE_KEY,
      value
    );
  } catch {
    /* 忽略：只是记住偏好的次要功能 */
  }
}

/**
 * 执行策略开关的存储键（值为 "1"/"0"）。
 *
 * v2：首版「自动执行」默认开，旧键可能残留用户当时保存的开启值；
 * 换键让所有人回到「默认都关」的起点。
 */
export const RUN_FLAG_KEYS = {
  autoExecute: "ai-auto-execute-v2",
  autoApply: "ai-auto-apply-v2"
} as const;

/**
 * 读取执行策略开关，跨启动记住。两个开关默认都关：
 * 只读命令与文件更改都需要用户手动确认。
 */
export function loadRunFlag(
  name: keyof typeof RUN_FLAG_KEYS
): boolean {
  try {
    return (
      localStorage.getItem(
        RUN_FLAG_KEYS[name]
      ) === "1"
    );
  } catch {
    return false;
  }
}

/** 保存执行策略开关，跨启动记住。 */
export function saveRunFlag(
  name: keyof typeof RUN_FLAG_KEYS,
  value: boolean
): void {
  try {
    localStorage.setItem(
      RUN_FLAG_KEYS[name],
      value ? "1" : "0"
    );
  } catch {
    /* 忽略：只是记住偏好的次要功能 */
  }
}

/** 工具结果回填给模型的上限：超长保留尾部（诊断价值在尾部）。 */
const TOOL_RESULT_LIMIT = 10000;

const SYSTEM_PROMPT = `你是终端应用里的运维 AI 助手，运行在用户的 SSH 服务器环境中。
你可以通过 run_command 工具在当前服务器上执行命令（客户端按设置自动执行或等用户确认）：
- command：要执行的命令，在用户主目录下以登录 shell 运行；每个命令独立，需要操作其他目录请用绝对路径或 cd xxx && 组合。
- question：一句话向用户解释这条命令做什么。
- is_read_only：纯读取类命令（查看、搜索、统计）设为 true；任何会修改服务器状态的命令（写文件、安装、重启、删除等）必须设为 false。
除非用户明确要求，不要执行破坏性或高风险命令。回答用简体中文，简洁、结论先行。`;

/** 拼一条用户消息末尾的上下文块（对齐 WisdomSSH 的 workspace 注入）。 */
function workspaceContext(
  session: OpenSession
): string {
  const target = `${session.username ? `${session.username}@` : ""}${session.host}:${session.port ?? 22}`;
  const now = new Date().toLocaleString("zh-CN", {
    hour12: false
  });
  return `<current_workspace>
当前时间: ${now}
当前打开的服务器会话:
  - 名称: ${session.name} (ip: ${session.host}) <- [当前]
  - 登录目标: ${target}
</current_workspace>`;
}

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

/** 单条 SSE 载荷消化后产生的用户可见增量。 */
export type StreamDelta = {
  content?: string;
  reasoning?: string;
};

/** 三种格式共用的流式累积器接口：逐条吃 SSE 载荷，吐增量与最终消息。 */
export type StreamAccumulator = {
  /** 处理一条已剥前缀的 SSE 载荷（JSON 文本），返回文本类增量 */
  feed: (payload: string) => StreamDelta;
  /** 组装最终的助手消息（content / reasoning / tool_calls） */
  finalize: () => ProtocolMessage;
};

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

/**
 * 流式对话补全：请求体加 stream:true 走 Rust SSE 桥，delta 通过
 * onDelta 实时回调（content / reasoning 增量），结束后返回组装完
 * 整的助手消息（与 chatCompletion 同形态，协议流无缝衔接）。
 *
 * withTools=false 时从请求体剥掉 run_command 工具定义 —— 命令解释
 * 这类纯文本请求若带着工具，模型可能直接回 tool_call 而没有正文。
 */
export async function streamChatCompletion(
  option: AiModelOption,
  messages: ProtocolMessage[],
  onDelta: (chunk: StreamDelta) => void,
  withTools = true
): Promise<ProtocolMessage> {
  const adapter = adapterOf(
    option.provider.apiFormat
  );
  const base = option.provider.baseUrl
    .trim()
    .replace(/\/+$/, "");
  const streamId = `ai-stream-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const accumulator = accumulatorOf(
    option.provider.apiFormat
  );

  const { listen } =
    await import("@tauri-apps/api/event");
  let streamError: string | null = null;
  let done = false;
  let wakeDone: () => void = () => {};
  const donePromise = new Promise<void>(
    resolve => {
      wakeDone = resolve;
    }
  );

  // 单一监听器：数据载荷喂累积器并回调增量；done / error 负责收尾
  const unlisten = await listen<{
    streamId: string;
    data?: string;
    done?: boolean;
    error?: string;
  }>("ai-chat-stream", event => {
    const payload = event.payload;
    if (payload.streamId !== streamId) return;
    if (payload.error) {
      streamError = payload.error;
    }
    if (payload.done) {
      done = true;
      wakeDone();
      return;
    }
    if (payload.data) {
      try {
        const delta = accumulator.feed(
          payload.data
        );
        if (delta.content || delta.reasoning) {
          onDelta(delta);
        }
      } catch {
        /* 单条坏载荷跳过，不打断整条流 */
      }
    }
  });

  try {
    const built = adapter.buildBody(
      option,
      messages
    ) as Record<string, unknown>;
    if (!withTools) {
      delete built.tools;
      delete built.tool_choice;
    }
    await invoke("ai_chat_stream", {
      streamId,
      url: adapter.endpoint(base),
      headers: adapter.headers(
        option.provider.apiKey
      ),
      body: { ...built, stream: true }
    });
    // 命令返回前已广播 done 事件，这里等监听器确认到达（留宽限兜底）
    if (!done) {
      await Promise.race([
        donePromise,
        new Promise(resolve =>
          setTimeout(resolve, 1500)
        )
      ]);
    }
    if (streamError) throw new Error(streamError);
    return accumulator.finalize();
  } finally {
    unlisten();
  }
}

/** 工具结果 / 卡片展示的截断：超长保留尾部，并按 WisdomSSH 的格式注明。 */
export function trimToolOutput(
  raw: string
): string {
  if (raw.length <= TOOL_RESULT_LIMIT) return raw;
  return `[内容太长，已截断。原始长度: ${raw.length} 字符，显示最后 ${TOOL_RESULT_LIMIT} 字符]\n${raw.slice(
    -TOOL_RESULT_LIMIT
  )}`;
}

/** 解析包装命令（`hostname; pwd; echo ---; 原命令`）的输出头部。 */
function parseWrappedOutput(stdout: string): {
  hostName: string;
  cwd: string;
  output: string;
} {
  const [header = "", ...rest] =
    stdout.split("\n---\n");
  const [hostName = "", cwd = ""] =
    header.split("\n");
  return {
    hostName: hostName.trim(),
    cwd: cwd.trim(),
    output: rest.join("\n---\n")
  };
}

/** 解析模型的 tool_call 参数；参数不合法时给出可读错误。 */
export function parseToolArguments(raw: string): {
  command: string;
  question: string;
  isReadOnly: boolean;
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const command =
      typeof parsed.command === "string"
        ? parsed.command
        : "";
    if (!command.trim()) return null;
    return {
      command,
      question:
        typeof parsed.question === "string"
          ? parsed.question
          : "",
      isReadOnly: parsed.is_read_only === true
    };
  } catch {
    return null;
  }
}

/** 面板内一轮对话的状态与动作。 */
export function useAiChat(
  session: OpenSession | undefined,
  /** 执行策略：autoExecute = 只读命令自动执行；autoApply = 读写命令自动应用 */
  runOptions: {
    autoExecute: boolean;
    autoApply: boolean;
  }
) {
  // ref 透传：切换开关即时生效且不必重建 runLoop 及其依赖链
  const runOptionsRef = useRef(runOptions);
  useEffect(() => {
    runOptionsRef.current = runOptions;
  }, [runOptions]);
  const [entries, setEntries] = useState<
    AiChatEntry[]
  >([]);
  /** 协议消息流：含 system / tool 等内部消息，与 entries 分开维护 */
  const messagesRef = useRef<ProtocolMessage[]>(
    []
  );
  const [busy, setBusy] = useState(false);
  /** 正在等待确认的读写卡片 id（循环在此暂停） */
  const [pendingCardId, setPendingCardId] =
    useState<string | null>(null);
  /** 循环的驱动句柄：确认 / 跳过后从暂停点继续 */
  const resumeRef = useRef<(() => void) | null>(
    null
  );
  /** 挂起中卡片的执行信息（命令文本），确认时取用 */
  const pendingRef = useRef<
    Map<
      string,
      { call: AiToolCall; toolCallId: string }
    >
  >(new Map());
  const [error, setError] = useState("");
  /** 正在流式生成的助手消息（null = 没有进行中的流） */
  const [stream, setStream] = useState<{
    text: string;
    reasoning: string;
  } | null>(null);

  /** 当前对话对应的历史 id（null = 还没落过盘，首次保存时新建） */
  const historyIdRef = useRef<string | null>(
    null
  );
  /** 标题钉死在首次落盘/恢复/手动重命名时，避免后续保存把改名冲掉 */
  const historyTitleRef = useRef<string | null>(
    null
  );

  // 引擎空闲且有内容时自动落一份历史快照（含协议消息，恢复后可续聊）
  useEffect(() => {
    if (busy || !session || entries.length === 0)
      return;
    if (!historyIdRef.current) {
      historyIdRef.current = crypto.randomUUID();
      const firstUser = entries.find(
        entry => entry.kind === "user"
      );
      const title =
        firstUser && firstUser.kind === "user"
          ? firstUser.text.trim() || "（图片）"
          : "对话";
      historyTitleRef.current = title.slice(
        0,
        40
      );
    }
    saveHistory({
      id: historyIdRef.current,
      title: historyTitleRef.current ?? "对话",
      host: session.host,
      updatedAt: Date.now(),
      entries,
      messages: messagesRef.current
    });
  }, [busy, entries, session]);

  /** 列表里改名：若改的正是当前对话，钉住标题防止下次自动保存冲掉。 */
  const renameCurrent = useCallback(
    (id: string, title: string) => {
      if (historyIdRef.current === id)
        historyTitleRef.current = title;
    },
    []
  );

  /** 恢复一条历史：替换展示与协议流，继续对话会覆盖这条历史。 */
  const restore = useCallback(
    (history: AiHistory) => {
      historyIdRef.current = history.id;
      historyTitleRef.current = history.title;
      messagesRef.current =
        history.messages as ProtocolMessage[];
      setEntries(
        history.entries as AiChatEntry[]
      );
      setPendingCardId(null);
      setError("");
      setStream(null);
    },
    []
  );

  const clear = useCallback(() => {
    messagesRef.current = [];
    pendingRef.current.clear();
    setEntries([]);
    setPendingCardId(null);
    setError("");
    setStream(null);
    resumeRef.current = null;
    // 清空后下一次保存开一条新历史，不覆盖旧的
    historyIdRef.current = null;
    historyTitleRef.current = null;
  }, []);

  /** 执行一张卡片并把结果回填进协议流。mode 见 ExecCardMode。 */
  const executeCard = useCallback(
    async (
      call: AiToolCall,
      toolCallId: string,
      mode: ExecCardMode = "background",
      skip = false
    ) => {
      let content: string;
      if (skip) {
        call.state = "failed";
        call.error = "用户跳过了这条命令";
        content = "[用户跳过了这条命令，未执行]";
      } else if (mode === "terminal") {
        // 终端模式：命令写进活动会话的 PTY（同快捷宏路径），
        // 输出在终端里可见；稍后抓取缓冲区尾部作为工具结果回填
        call.state = "running";
        setEntries(list => [...list]);
        try {
          await invoke("terminal_write", {
            id: session?.id,
            data: `${call.command}\r`,
            command: call.command
          });
          session?.terminal.focus();
          // 固定 1.2 秒后抓缓冲区尾部：ponytail 简化 —— 慢命令拿到的只是
          // 中间输出，升级方向是监听输出静默期再抓
          await new Promise(resolve =>
            setTimeout(resolve, 1200)
          );
          const tail = terminalTail(
            session?.terminal,
            30
          );
          call.state = "done";
          call.stdout = trimToolOutput(tail);
          call.exitCode = -1;
          content = `[已在终端执行，以下为终端当前输出尾部]\n${call.stdout}`;
        } catch (reason) {
          call.state = "failed";
          call.error = String(reason);
          content = `[执行失败] ${String(reason)}`;
        }
      } else {
        call.state = "running";
        setEntries(list => [...list]);
        try {
          // 包装命令：先取主机名与当前目录，用于合成终端风格的提示符行，
          // 让执行结果与终端里看到的形态一致（含 `user@host:cwd# 命令`）
          const result = await aiRunCommand(
            {
              host: session?.host ?? "",
              port: session?.port,
              username: session?.username,
              password: session?.password
            },
            `hostname; pwd; echo ---; ${call.command}`
          );
          // 通道执行完成即为 done：退出码非 0 是命令的正常输出
          // （如验证文件已删除的 ls、无匹配的 grep），由模型自行解读
          call.state = "done";
          call.stderr = result.stderr;
          call.exitCode = result.exitCode;
          const { hostName, cwd, output } =
            parseWrappedOutput(result.stdout);
          const promptLine = `${session?.username ?? "root"}@${hostName || session?.host || ""}:${cwd}# ${call.command}`;
          call.stdout = trimToolOutput(
            `${promptLine}\n${output}`
          );
          content = trimToolOutput(
            `退出码: ${result.exitCode}\n${promptLine}\n${output}${
              result.stderr
                ? `\n[stderr]\n${result.stderr}`
                : ""
            }`
          );
        } catch (reason) {
          call.state = "failed";
          call.error = String(reason);
          content = `[执行失败] ${String(reason)}`;
        }
      }
      setEntries(list => [...list]);
      messagesRef.current.push({
        role: "tool",
        content,
        tool_call_id: toolCallId
      });
    },
    [session]
  );

  /** 工具循环：从当前协议流继续请求模型，直到出现普通回复或等确认。 */
  const runLoop = useCallback(
    async (option: AiModelOption) => {
      const MAX_HOPS = 8;
      for (
        let hop = 0;
        hop < MAX_HOPS;
        hop += 1
      ) {
        const startedAt = Date.now();
        // 流式：先挂一条空的流式条目，delta 到达就地追加，结束后落为正式条目
        setStream({ text: "", reasoning: "" });
        const message =
          await streamChatCompletion(
            option,
            messagesRef.current,
            chunk => {
              setStream(prev =>
                prev
                  ? {
                      text:
                        prev.text +
                        (chunk.content ?? ""),
                      reasoning:
                        prev.reasoning +
                        (chunk.reasoning ?? "")
                    }
                  : prev
              );
            }
          );
        messagesRef.current.push(message);
        setStream(null);
        if (
          message.content?.trim() ||
          message.reasoning
        ) {
          setEntries(list => [
            ...list,
            {
              kind: "assistant",
              text: message.content ?? "",
              ...(message.reasoning
                ? {
                    reasoning: message.reasoning,
                    elapsedSeconds:
                      (Date.now() - startedAt) /
                      1000
                  }
                : {})
            }
          ]);
        }
        const calls = message.tool_calls ?? [];
        if (calls.length === 0) return; // 普通回复，本轮结束
        let yielded = false;
        for (const call of calls) {
          const parsed = parseToolArguments(
            call.function.arguments
          );
          const toolCallId = call.id;
          if (!parsed) {
            // 参数不合法也要回填 tool 消息，否则协议流断裂
            messagesRef.current.push({
              role: "tool",
              content: "[参数解析失败，请重试]",
              tool_call_id: toolCallId
            });
            continue;
          }
          const card: AiToolCall = {
            id: toolCallId,
            command: parsed.command,
            question: parsed.question,
            isReadOnly: parsed.isReadOnly,
            state: "pending"
          };
          setEntries(list => [
            ...list,
            { kind: "tool", call: card }
          ]);
          const { autoExecute, autoApply } =
            runOptionsRef.current;
          // 关键决策日志：排查「没弹确认卡就执行了」时看模型给的只读
          // 标记与生效开关（is_read_only 由模型自报，可能标错）
          console.info(
            "[ai-exec]",
            card.command,
            "isReadOnly:",
            card.isReadOnly,
            "autoExecute:",
            autoExecute,
            "autoApply:",
            autoApply
          );
          if (
            card.isReadOnly
              ? autoExecute
              : autoApply
          ) {
            await executeCard(card, toolCallId);
            continue;
          }
          // 未开自动执行 / 应用：登记后暂停循环，等用户点执行 / 跳过
          pendingRef.current.set(toolCallId, {
            call: card,
            toolCallId
          });
          setPendingCardId(toolCallId);
          yielded = true;
          break;
        }
        if (yielded) {
          // 挂起：等确认 / 跳过后由 confirm / skip 里新一轮
          // runLoop 接管剩余循环，这里直接收尾。
          // 关键：runLoop 挂起时 send 的 await 还没返回，busy 仍是 true，
          // 不释放的话执行 / 后台执行 / 跳过按钮会一直处于禁用状态
          setBusy(false);
          await new Promise<void>(resolve => {
            resumeRef.current = resolve;
          });
          setPendingCardId(null);
          return;
        }
      }
    },
    [executeCard]
  );

  const send = useCallback(
    async (
      text: string,
      option: AiModelOption | null,
      /** 用户上传的图片（data URL），可只发图不发消息 */
      images: string[] = []
    ) => {
      const trimmed = text.trim();
      if (
        (!trimmed && images.length === 0) ||
        busy ||
        pendingCardId ||
        !session
      )
        return;
      if (!option) {
        setError(
          "请先在「模型设置」里配置一个 OpenAI 兼容的供应商和模型"
        );
        return;
      }
      setError("");
      setBusy(true);
      setEntries(list => [
        ...list,
        {
          kind: "user",
          text: trimmed,
          ...(images.length ? { images } : {})
        }
      ]);
      const messages = messagesRef.current;
      if (messages.length === 0) {
        messages.push({
          role: "system",
          content: SYSTEM_PROMPT
        });
      }
      messages.push({
        role: "user",
        content: `${trimmed}\n\n${workspaceContext(session)}`,
        ...(images.length ? { images } : {})
      });
      try {
        await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
        setStream(null);
      }
    },
    [busy, pendingCardId, runLoop, session]
  );

  /** 确认执行一张待确认的读写卡片，随后继续工具循环。 */
  const confirm = useCallback(
    async (
      cardId: string,
      option: AiModelOption | null,
      mode: ExecCardMode = "background"
    ) => {
      const held = pendingRef.current.get(cardId);
      if (!held || !option) return;
      setBusy(true);
      pendingRef.current.delete(cardId);
      resumeRef.current?.();
      await executeCard(
        held.call,
        held.toolCallId,
        mode
      );
      try {
        await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
        setStream(null);
      }
    },
    [executeCard, runLoop]
  );

  /** 跳过一张待确认的卡片：以"用户跳过"回填后继续循环。 */
  const skip = useCallback(
    async (
      cardId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(cardId);
      if (!held || !option) return;
      setBusy(true);
      pendingRef.current.delete(cardId);
      await executeCard(
        held.call,
        held.toolCallId,
        "background",
        true
      );
      try {
        await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
        setStream(null);
      }
    },
    [executeCard, runLoop]
  );

  return {
    entries,
    busy,
    pendingCardId,
    error,
    stream,
    send,
    confirm,
    skip,
    clear,
    restore,
    renameCurrent
  };
}
