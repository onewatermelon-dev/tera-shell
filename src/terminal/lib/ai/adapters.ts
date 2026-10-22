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
  AiUsage,
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
    },
    escalate: {
      type: "boolean",
      description:
        "这条命令是否需要 root 权限。只有在需要写 /etc、装包、改服务、读 root 家目录等特权操作时设为 true；普通查看不要设"
    }
  },
  required: [
    "command",
    "question",
    "is_read_only"
  ]
};

/**
 * upload_local_file 工具的 JSON Schema。
 *
 * ⚠️ **没有本地路径参数**：模型不能指定要读哪个本地文件，那等于开了
 * 任意文件读取的口子 —— 用户必须在系统「打开文件」框里亲自挑。所以这里
 * 只描述远程落点。
 */
const UPLOAD_FILE_PARAMETERS = {
  type: "object",
  properties: {
    remote_path: {
      type: "string",
      description:
        "服务器上的目标路径（绝对路径），如 /tmp/deploy.tar.gz"
    },
    question: {
      type: "string",
      description: "向用户解释这次上传的用途"
    }
  },
  required: ["remote_path", "question"]
};

/**
 * download_remote_file 工具的 JSON Schema。
 *
 * 落点同样由用户在「另存为」框里定，模型只给源路径。
 */
const DOWNLOAD_FILE_PARAMETERS = {
  type: "object",
  properties: {
    remote_path: {
      type: "string",
      description:
        "服务器上要下载的文件路径（绝对路径）"
    },
    question: {
      type: "string",
      description: "向用户解释这次下载的用途"
    }
  },
  required: ["remote_path", "question"]
};

/**
 * propose_plan 工具的 JSON Schema。
 *
 * 多步计划专用：模型先提出步骤清单，用户在计划卡上批准后才逐步执行。
 * 每步是一条完整的非交互命令 —— 执行通道 stdin 是关闭的（见
 * SYSTEM_PROMPT），交互命令会挂起。
 */
const PROPOSE_PLAN_PARAMETERS = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "计划标题，一句话概括"
    },
    summary: {
      type: "string",
      description: "计划目标与范围的简要说明"
    },
    steps: {
      type: "array",
      description:
        "按顺序执行的步骤（2-12 步，每步一条命令）",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "步骤标题，一句话"
          },
          detail: {
            type: "string",
            description: "可选：步骤的补充说明"
          },
          command: {
            type: "string",
            description:
              "这一步要执行的 shell 命令（必须是非交互命令）"
          },
          is_read_only: {
            type: "boolean",
            description:
              "纯读取类命令为 true，会修改服务器状态必须为 false"
          },
          escalate: {
            type: "boolean",
            description:
              "这一步是否需要 root 权限（需要装包 / 改服务 / 写 /etc 时设 true）"
          }
        },
        required: [
          "title",
          "command",
          "is_read_only"
        ]
      }
    }
  },
  required: ["title", "summary", "steps"]
};

/**
 * ask_questions 工具的 JSON Schema。
 *
 * 信息不足以继续时向用户反问：逐题展示候选项，用户点选作答（客户端
 * 会自动追加一个自由输入的「其他」项，模型不用给）。答完才继续，
 * 不答按最安全默认方案处理。
 */
const ASK_QUESTIONS_PARAMETERS = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "这组提问的标题，一句话"
    },
    questions: {
      type: "array",
      description:
        "要问的问题（1-5 题，按顺序逐题展示）",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "题目标识，如 q1（组内不可重复）"
          },
          prompt: {
            type: "string",
            description: "问题正文"
          },
          options: {
            type: "array",
            description:
              "候选项（1-6 个，客户端会再加一个自由输入项）",
            items: { type: "string" }
          }
        },
        required: ["id", "prompt", "options"]
      }
    }
  },
  required: ["title", "questions"]
};

/**
 * edit_remote_file 工具的 JSON Schema。
 *
 * 改服务器上的文件：模型给出路径与若干「查找/替换」块，客户端读真实
 * 文件、本地应用、算出 diff 给用户看，批准后才写回。模型**不需要**
 * （也不允许）给出整份新文件内容 —— 那既是 token 浪费，也容易在
 * 长文件上编造。
 */
const EDIT_FILE_PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "要修改的文件（服务器上的绝对路径）"
    },
    summary: {
      type: "string",
      description: "一句话说明这次改什么"
    },
    edits: {
      type: "array",
      description:
        "查找/替换块（1-20 处）；每个 old_string 必须在文件里唯一匹配",
      items: {
        type: "object",
        properties: {
          old_string: {
            type: "string",
            description:
              "要被替换的原文（原样拷贝，含缩进）"
          },
          new_string: {
            type: "string",
            description: "替换成的新文本"
          }
        },
        required: ["old_string", "new_string"]
      }
    }
  },
  required: ["path", "summary", "edits"]
};

/** 四个工具的名字：前端按 `function.name` 分派，三处注入必须一致。 */
export const TOOL_RUN_COMMAND = "run_command";
export const TOOL_UPLOAD_FILE =
  "upload_local_file";
export const TOOL_DOWNLOAD_FILE =
  "download_remote_file";
export const TOOL_PROPOSE_PLAN = "propose_plan";
export const TOOL_ASK_QUESTIONS = "ask_questions";
export const TOOL_EDIT_FILE = "edit_remote_file";

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
          name: TOOL_RUN_COMMAND,
          description:
            "在当前 SSH 服务器上执行一条 shell 命令并返回输出",
          parameters: RUN_COMMAND_PARAMETERS
        }
      },
      {
        type: "function",
        function: {
          name: TOOL_UPLOAD_FILE,
          description:
            "让用户从本地选一个文件并上传到服务器指定路径（用户会在系统弹窗里亲自挑选本地文件）",
          parameters: UPLOAD_FILE_PARAMETERS
        }
      },
      {
        type: "function",
        function: {
          name: TOOL_DOWNLOAD_FILE,
          description:
            "把服务器上的一个文件下载到本地（用户会在系统弹窗里亲自选择保存位置）",
          parameters: DOWNLOAD_FILE_PARAMETERS
        }
      },
      {
        type: "function",
        function: {
          name: TOOL_PROPOSE_PLAN,
          description:
            "向用户提出一个多步执行计划（步骤清单），等用户在计划卡上批准后才按步骤执行。用于 2 步以上、会改变服务器状态的复杂任务（部署、配置变更、批量操作）；单条命令不要用",
          parameters: PROPOSE_PLAN_PARAMETERS
        }
      },
      {
        type: "function",
        function: {
          name: TOOL_ASK_QUESTIONS,
          description:
            "信息不足以继续时向用户反问（逐题给出候选项，用户点选或填「其他」）。只在缺了信息就没法正确执行时才用；能合理默认的就不要问",
          parameters: ASK_QUESTIONS_PARAMETERS
        }
      },
      {
        type: "function",
        function: {
          name: TOOL_EDIT_FILE,
          description:
            "修改服务器上的文件：给出路径与「查找/替换」块，用户会在 diff 卡上审查并批准后才写回。不要给出整份文件内容",
          parameters: EDIT_FILE_PARAMETERS
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
          name: TOOL_RUN_COMMAND,
          description:
            "在当前 SSH 服务器上执行一条 shell 命令并返回输出",
          input_schema: RUN_COMMAND_PARAMETERS
        },
        {
          name: TOOL_UPLOAD_FILE,
          description:
            "让用户从本地选一个文件并上传到服务器指定路径（用户会在系统弹窗里亲自挑选本地文件）",
          input_schema: UPLOAD_FILE_PARAMETERS
        },
        {
          name: TOOL_DOWNLOAD_FILE,
          description:
            "把服务器上的一个文件下载到本地（用户会在系统弹窗里亲自选择保存位置）",
          input_schema: DOWNLOAD_FILE_PARAMETERS
        },
        {
          name: TOOL_PROPOSE_PLAN,
          description:
            "向用户提出一个多步执行计划（步骤清单），等用户在计划卡上批准后才按步骤执行。用于 2 步以上、会改变服务器状态的复杂任务（部署、配置变更、批量操作）；单条命令不要用",
          input_schema: PROPOSE_PLAN_PARAMETERS
        },
        {
          name: TOOL_ASK_QUESTIONS,
          description:
            "信息不足以继续时向用户反问（逐题给出候选项，用户点选或填「其他」）。只在缺了信息就没法正确执行时才用；能合理默认的就不要问",
          input_schema: ASK_QUESTIONS_PARAMETERS
        },
        {
          name: TOOL_EDIT_FILE,
          description:
            "修改服务器上的文件：给出路径与「查找/替换」块，用户会在 diff 卡上审查并批准后才写回。不要给出整份文件内容",
          input_schema: EDIT_FILE_PARAMETERS
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
          name: TOOL_RUN_COMMAND,
          description:
            "在当前 SSH 服务器上执行一条 shell 命令并返回输出",
          parameters: RUN_COMMAND_PARAMETERS
        },
        {
          type: "function",
          name: TOOL_UPLOAD_FILE,
          description:
            "让用户从本地选一个文件并上传到服务器指定路径（用户会在系统弹窗里亲自挑选本地文件）",
          parameters: UPLOAD_FILE_PARAMETERS
        },
        {
          type: "function",
          name: TOOL_DOWNLOAD_FILE,
          description:
            "把服务器上的一个文件下载到本地（用户会在系统弹窗里亲自选择保存位置）",
          parameters: DOWNLOAD_FILE_PARAMETERS
        },
        {
          type: "function",
          name: TOOL_PROPOSE_PLAN,
          description:
            "向用户提出一个多步执行计划（步骤清单），等用户在计划卡上批准后才按步骤执行。用于 2 步以上、会改变服务器状态的复杂任务（部署、配置变更、批量操作）；单条命令不要用",
          parameters: PROPOSE_PLAN_PARAMETERS
        },
        {
          type: "function",
          name: TOOL_ASK_QUESTIONS,
          description:
            "信息不足以继续时向用户反问（逐题给出候选项，用户点选或填「其他」）。只在缺了信息就没法正确执行时才用；能合理默认的就不要问",
          parameters: ASK_QUESTIONS_PARAMETERS
        },
        {
          type: "function",
          name: TOOL_EDIT_FILE,
          description:
            "修改服务器上的文件：给出路径与「查找/替换」块，用户会在 diff 卡上审查并批准后才写回。不要给出整份文件内容",
          parameters: EDIT_FILE_PARAMETERS
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
  // usage 在**最后一个 chunk** 才给（且要请求体带
  // stream_options.include_usage，见 stream.ts），零散的不收
  let usage: AiUsage | undefined;
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
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: {
            cached_tokens?: number;
          };
        };
      };
      // 用量 chunk 没有 choices，别当成空 delta 提前返回
      if (chunk.usage) {
        usage = {
          inputTokens:
            chunk.usage.prompt_tokens ?? 0,
          outputTokens:
            chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.prompt_tokens_details
            ?.cached_tokens != null
            ? {
                cachedInputTokens:
                  chunk.usage
                    .prompt_tokens_details
                    .cached_tokens
              }
            : {})
        };
      }
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
    },
    usage: () => usage
  };
}

/** Anthropic 流：content_block_start/delta 按 index 归属，tool_use 的参数经 input_json_delta 分片。 */
function anthropicAccumulator(): StreamAccumulator {
  let text = "";
  let thinking = "";
  // usage 拆两个事件：message_start 给 input，message_delta 给 output
  let usage: AiUsage | undefined;
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
        message?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        usage?: {
          output_tokens?: number;
        };
      };
      // message_start：整条消息的输入用量（含缓存读取）
      if (event.type === "message_start") {
        const start = event.message?.usage;
        if (start)
          usage = {
            inputTokens: start.input_tokens ?? 0,
            outputTokens: 0,
            ...(start.cache_read_input_tokens !=
            null
              ? {
                  cachedInputTokens:
                    start.cache_read_input_tokens
                }
              : {})
          };
        return {};
      }
      // message_delta：输出用量（累计值，直接覆盖）
      if (event.type === "message_delta") {
        if (usage && event.usage)
          usage = {
            ...usage,
            outputTokens:
              event.usage.output_tokens ?? 0
          };
        return {};
      }
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
    },
    usage: () => usage
  };
}

/** Responses 流：文本/摘要走 delta 事件，函数调用按 item_id 归并，completed 事件带 usage。 */
function responsesAccumulator(): StreamAccumulator {
  let content = "";
  let reasoning = "";
  let usage: AiUsage | undefined;
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
        response?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: {
              cached_tokens?: number;
            };
          };
        };
      };
      // response.completed：整次调用的用量别在 response 对象里
      if (
        event.type === "response.completed" &&
        event.response?.usage
      ) {
        const done = event.response.usage;
        usage = {
          inputTokens: done.input_tokens ?? 0,
          outputTokens: done.output_tokens ?? 0,
          ...(done.input_tokens_details
            ?.cached_tokens != null
            ? {
                cachedInputTokens:
                  done.input_tokens_details
                    .cached_tokens
              }
            : {})
        };
        return {};
      }
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
    },
    usage: () => usage
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
