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

// 面板偏好（选中模型/执行开关/黑名单）落在数据目录的 ai_prefs.json，
// 这里原样转发，AiPanel 等调用方保持原导入路径不变
export {
  loadSelectedModel,
  saveSelectedModel,
  loadRunFlag,
  saveRunFlag,
  loadBlacklist,
  saveBlacklist
} from "@/terminal/lib/aiPrefs";

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
      /** 用户发送时间（毫秒时间戳）。 */
      sentAt?: number;
      /** 用户上传的图片（data URL），仅展示用 */
      images?: string[];
    }
  | {
      kind: "assistant";
      text: string;
      /** 助手回复完成时间（毫秒时间戳）。 */
      sentAt?: number;
      /** 思考内容（有才显示 ReasoningBlock） */
      reasoning?: string;
      /** 思考耗时（秒） */
      elapsedSeconds?: number;
    }
  | { kind: "tool"; call: AiToolCall };

/**
 * 排队中的一条用户消息。
 *
 * AI 还在跑（busy）或正等工具确认（pendingCardId）时，用户再发的消息
 * 不该被丢弃 —— 之前 `send` 开头直接 return，Enter 键按下去毫无反应，
 * 用户以为没发出去。这里把这类消息存起来，等本轮结束自动接着发。
 */
export type AiQueuedMessage = {
  id: string;
  /** 消息正文（已trim）。 */
  text: string;
  /** 用户上传的图片（data URL）。 */
  images: string[];
};

/**
 * 新消息入队后的队列。
 *
 * 单独抽成纯函数是为了能直接单测：FIFO 与「同 id 覆盖」这两条规则
 * 一旦写错，症状是消息乱序或编辑后多出一条重复，UI 上很难看出根因。
 *
 * @param queue 现有队列
 * @param message 入队消息（id 为空时自动生成）
 * @returns 新队列
 */
export function enqueueMessage(
  queue: AiQueuedMessage[],
  message: Omit<AiQueuedMessage, "id"> & {
    id?: string;
  }
): AiQueuedMessage[] {
  const id = message.id ?? crypto.randomUUID();
  const next = message.text.trim();
  // 显式复制 images：调用方（AiPanel）发完就 setAttachments([])，
  // 队列条目不能跟它共享同一个数组引用
  const images = [...message.images];
  const prevIndex = queue.findIndex(
    item => item.id === id
  );
  // 同 id = 编辑：原位替换，不追加 —— 否则编辑一次多一条
  if (prevIndex >= 0) {
    const copy = [...queue];
    copy[prevIndex] = { id, text: next, images };
    return copy;
  }
  // 空消息（既无文字也无图）不进队列：会占一个永远发不出去的条目
  if (!next && images.length === 0) return queue;
  return [...queue, { id, text: next, images }];
}

/** 队列里移除一条，返回新队列。 */
export function dequeueMessage(
  queue: AiQueuedMessage[],
  id: string
): AiQueuedMessage[] {
  return queue.filter(item => item.id !== id);
}

/**
 * 把队列里的一条挪到另一条的位置（按住手柄拖动换序）。
 *
 * 语义是「占掉目标的槽位」：向下拖时结果落在目标**之后**（因为移除自己
 * 后目标左移了一位），向上拖时落在目标**之前**。两种方向都符合"越过
 * 落点那一行就换到它后面"的直觉。
 *
 * 单独抽纯函数的原因：数组 splice 的下标位移很容易写反，肉眼看不出
 * 到底插到了前面还是后面，单测能钉死。
 *
 * @param queue 现有队列
 * @param id 被拖动那条的 id
 * @param targetId 落点那条的 id
 * @returns 新队列；任一 id 不存在或两者相同则原样返回
 */
export function moveQueued(
  queue: AiQueuedMessage[],
  id: string,
  targetId: string
): AiQueuedMessage[] {
  if (id === targetId) return queue;
  const from = queue.findIndex(
    item => item.id === id
  );
  const to = queue.findIndex(
    item => item.id === targetId
  );
  if (from < 0 || to < 0) return queue;
  const copy = [...queue];
  // noUncheckedIndexedAccess：splice 返回的数组首项可能是 undefined
  const [moved] = copy.splice(from, 1);
  if (!moved) return queue;
  copy.splice(to, 0, moved);
  return copy;
}

/**
 * 按方向挪动一条（上移/下移一位），给手柄的键盘操作用。
 *
 * 拖拽只能用鼠标，键盘用户够不到 —— 这个函数让 Tab 到手柄后按方向键
 * 也能换序。
 *
 * @param queue 现有队列
 * @param id 目标条的 id
 * @param delta -1 上移，1 下移
 * @returns 新队列；已在边界则原样返回
 */
export function nudgeQueued(
  queue: AiQueuedMessage[],
  id: string,
  delta: -1 | 1
): AiQueuedMessage[] {
  const from = queue.findIndex(
    item => item.id === id
  );
  const to = from + delta;
  if (from < 0 || to < 0 || to >= queue.length)
    return queue;
  return moveQueued(
    queue,
    id,
    queue[to]?.id ?? id
  );
}

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

/**
 * 轮次令牌：判断某次异步循环的收尾是否还有权改动共享状态。
 *
 * 背景见 hook 里的 `roundRef` 注释 —— 用户在卡片上点「执行 / 跳过」时，
 * 新一轮会 `resumeRef` 唤醒上一轮那个还挂着的 runLoop；它被唤醒后立刻
 * return，于是**上一轮的 finally 也会跑**。若不加区分，它的
 * `setBusy(false)` 会把新轮的 busy 冲掉（症状：点完卡片按钮，底部发送键
 * 立刻退回发送态）。
 *
 * 抽成纯函数是为了能单测 —— 竞态本身在 hook 内测不出来。
 *
 * @param mine 本次进入循环时领到的号
 * @param current 当前轮次计数器（ref 的当前值）
 * @returns true = 仍是当轮，可以收尾
 */
export function ownsRound(
  mine: number,
  current: number
): boolean {
  return mine === current;
}

/**
 * 修复工具调用的协议完整性：assistant 带 tool_calls 的消息，其后必须有
 * 每条 tool_call_id 的配对 tool 消息，缺一条供应商就返回 400。
 *
 * 断裂来源：挂起等确认时用户直接发新消息、历史恢复、异常中断等。
 * 缺失的按序补占位 tool 消息（告知模型该命令未获得结果）；id 配不上
 * 任何 tool_calls 的孤儿 tool 消息丢弃。纯函数不改入参。
 */
export function repairToolMessages(
  messages: ProtocolMessage[]
): ProtocolMessage[] {
  const out: ProtocolMessage[] = [];
  let pendingIds: string[] = [];
  const flush = () => {
    for (const id of pendingIds)
      out.push({
        role: "tool",
        content: "[该命令未获得执行结果，已跳过]",
        tool_call_id: id
      });
    pendingIds = [];
  };
  for (const msg of messages) {
    if (
      msg.role === "assistant" &&
      msg.tool_calls?.length
    ) {
      out.push(msg);
      pendingIds.push(
        ...msg.tool_calls.map(call => call.id)
      );
      continue;
    }
    if (msg.role === "tool") {
      // 孤儿 tool 消息（前面没有未配对的 tool_calls）直接丢弃
      if (
        !pendingIds.includes(
          msg.tool_call_id ?? ""
        )
      )
        continue;
      pendingIds = pendingIds.filter(
        id => id !== msg.tool_call_id
      );
      out.push(msg);
      continue;
    }
    // user / 无 tool_calls 的 assistant：新的一轮开始，先补齐欠账
    flush();
    out.push(msg);
  }
  flush();
  return out;
}

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

/**
 * 命令是否命中黑名单：扫描命令里**每一个**词的 basename（含 && ; | 管道
 * 拆出的后续命令与 sudo/env 前缀后的真命令）比对黑名单——复合命令
 * （`cd /root && rm -rf x`、`sh -c "rm ..."`）只看首词必然漏检。
 */
export function isBlacklisted(
  command: string,
  blacklist: string[]
): boolean {
  if (blacklist.length === 0) return false;
  const SKIP = new Set([
    "sudo",
    "doas",
    "env",
    "sh",
    "bash",
    "nohup",
    "xargs",
    "timeout"
  ]);
  for (const token of command
    .trim()
    .split(/[\s;&|]+/)) {
    const name = token
      .replace(/["']/g, "")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.toLowerCase();
    if (!name) continue;
    if (SKIP.has(name)) continue;
    if (blacklist.includes(name)) return true;
  }
  return false;
}

/** 工具结果回填给模型的上限：超长保留尾部（诊断价值在尾部）。 */
const TOOL_RESULT_LIMIT = 10000;

const SYSTEM_PROMPT = `你是终端应用里的运维 AI 助手，运行在用户的 SSH 服务器环境中。
你可以通过 run_command 工具在当前服务器上执行命令（客户端按设置自动执行或等用户确认）：
- command：要执行的命令；后台执行会先切换到当前终端所在目录，每个命令独立。
- question：一句话向用户解释这条命令做什么。
- is_read_only：纯读取类命令（查看、搜索、统计）设为 true；任何会修改服务器状态的命令（写文件、安装、重启、删除等）必须设为 false。
- 命令必须是**非交互**的：exec 通道的 stdin 是关闭的，任何等待键盘输入的命令（rm -i、apt/yum 不带 -y、passwd、交互式向导等）都会挂起直到超时。删除用 rm -f、安装用 apt-get install -y，需要确认的命令一律改用非交互参数。
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
  withTools = true,
  /**
   * 回调本次请求的 streamId。
   *
   * 「停止生成」要知道往哪条流发取消指令，而 streamId 是在这个函数内部
   * 生成的，调用方拿不到，所以开这个口子把它透出去。
   */
  onStreamId?: (streamId: string) => void
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
  // 占位初值写成`() => undefined` 而不是 `() => {}`：空块 `{}` 紧跟在
  // 返回类型后面容易被解析器当成函数体开头，踩过一次语法错。
  let wakeDone: () => void = () => undefined;
  const donePromise = new Promise<void>(
    resolve => {
      wakeDone = resolve;
    }
  );
  // 尽早把 streamId 交出去：调用方要靠它发取消指令，
  // 而监听器挂上、请求发出之后用户随时可能点停止
  onStreamId?.(streamId);

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

/**
 * 停止一次进行中的流式请求。
 *
 * 必须连后端一起掐：只在前端放弃监听的话，reqwest 仍在向模型网关拉数据
 * —— 白烧 token，且连接要等到流结束才释放。
 */
export async function cancelChatStream(
  streamId: string
): Promise<void> {
  try {
    const { invoke } =
      await import("@tauri-apps/api/core");
    const hit = await invoke<boolean>(
      "ai_chat_cancel",
      { streamId }
    );
    console.info(
      `[ai] 已请求停止生成（${
        hit ? "命中" : "流已结束"
      }）`
    );
  } catch (reason) {
    // 停止是用户主动操作，失败不该弹错误打扰他；但必须留痕
    console.error("[ai] 停止生成失败", reason);
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

/** 从当前终端提示符读取目录；没有可识别的提示符时返回 null。 */
export function directoryFromPrompt(
  terminal: Terminal | undefined
): string | null {
  if (!terminal) return null;
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(
    buffer.baseY + buffer.cursorY
  );
  const text =
    line?.translateToString(true) ?? "";
  return (
    text.match(
      /(?:^|\s)[^\s@]+@[^\s:]+:(~(?:\/[^\s#$]*)?|\/[^\s#$]*)[#$](?:\s|$)/
    )?.[1] ?? null
  );
}

/** 安全地把提示符目录拼进独立 SSH 命令。 */
export function commandInDirectory(
  directory: string,
  command: string
): string {
  const quote = (value: string) =>
    `'${value.replace(/'/g, `'\\''`)}'`;
  const path =
    directory === "~"
      ? '"$HOME"'
      : directory.startsWith("~/")
        ? `"$HOME"/${quote(directory.slice(2))}`
        : quote(directory);
  return `cd -- ${path} || exit 1\n${command}`;
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
  /** 执行策略：autoExecute = 只读命令自动执行；autoApply = 读写命令自动应用；blacklist = 命中即禁止自动执行 */
  runOptions: {
    autoExecute: boolean;
    autoApply: boolean;
    blacklist: string[];
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
  /**
   * 排队中的用户消息（AI 在跑或等确认时发送的）。
   *
   * 用 state 而非 ref：输入框上方要把队列画出来，ref 写它不触发渲染。
   * 出队时机在 confirm / skip / send 的 finally 里 —— 三条路径都可能让
   * busy 与 pendingCardId 同时归零。
   */
  const [queued, setQueued] = useState<
    AiQueuedMessage[]
  >([]);
  /**
   * 最近一次调用 send/confirm/skip 时用的模型。
   *
   * 队列续发发生在 effect 里，那时已拿不到调用处的入参，只能靠这个 ref
   * 接力。用 ref 而非 state：它只在发送瞬间写，不需要触发渲染。
   */
  const optionRef = useRef<AiModelOption | null>(
    null
  );
  /**
   * 本次请求的 streamId：供「停止生成」发取消指令。
   *
   * 用 ref 而非 state：它只在请求发起瞬间写一次，不需要触发渲染；
   * 而 stop() 要能立刻读到它。
   */
  const streamIdRef = useRef<string | null>(null);
  /**
   * 用户是否主动点过「停止生成」。
   *
   * 关键：cancel 只掐掉 HTTP 流，runLoop 的 for 循环本身还在跑 —— 不看
   * 这个标记的话，模型这一轮若带 tool_calls，循环会继续发下一跳请求，
   * 等于无视用户的停止意图。每跳开头查它。
   */
  const stoppedRef = useRef(false);
  /**
   * 当前轮次令牌。每条「进入循环」的路径（dispatch / confirm / skip）先
   * 自增取一个自己的号，收尾时用 `ownsRound(round, roundRef.current)` 判是否仍当轮
   * 判断自己是否仍是当轮。
   *
   * ⚠️ 不加这个会出很难查的竞态：用户在卡片上点「执行」时，`confirm`
   * 里的 `resumeRef.current?.()` 唤醒的是**上一轮**那个还挂着的 runLoop。
   * 它被唤醒后立刻 return → 上一轮的 `dispatch` finally 照样跑 →
   * `setBusy(false)` 把 confirm 刚设的 `busy=true` 冲掉。症状是
   * **点完卡片按钮，底部发送键立刻退回发送态**，而模型其实还在干活。
   * 同一个 finally 里的 `streamIdRef.current = null` 也会把新轮的流 id
   * 清掉，导致「停止」找不到流。
   */
  const roundRef = useRef(0);
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
  /**
   * 当前对话标题的**渲染态**。
   *
   * `historyTitleRef` 只是给自动保存 effect 读的，写它不触发重渲染 ——
   * 面板顶栏要显示标题，光靠 ref 是画不出来的。这里与 ref 同步维护：
   * 凡是给 ref 赋标题的地方都要同时 `setTitle`。
   */
  const [title, setTitle] = useState<
    string | null
  >(null);

  // 引擎空闲且有内容时自动落一份历史快照（含协议消息，恢复后可续聊）
  useEffect(() => {
    if (busy || !session || entries.length === 0)
      return;
    if (!historyIdRef.current) {
      historyIdRef.current = crypto.randomUUID();
      const firstUser = entries.find(
        entry => entry.kind === "user"
      );
      const generated =
        firstUser && firstUser.kind === "user"
          ? firstUser.text.trim() || "（图片）"
          : "对话";
      const trimmed = generated.slice(0, 40);
      historyTitleRef.current = trimmed;
      // 新建对话时给顶栏一个标题（见 title 的注释）
      setTitle(trimmed);
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
    (id: string, next: string) => {
      if (historyIdRef.current === id) {
        historyTitleRef.current = next;
        setTitle(next);
      }
    },
    []
  );

  /** 恢复一条历史：替换展示与协议流，继续对话会覆盖这条历史。 */
  const restore = useCallback(
    (history: AiHistory) => {
      historyIdRef.current = history.id;
      historyTitleRef.current = history.title;
      setTitle(history.title);
      messagesRef.current =
        history.messages as ProtocolMessage[];
      setEntries(
        (history.entries as AiChatEntry[]).map(
          entry =>
            entry.kind !== "tool"
              ? {
                  ...entry,
                  sentAt:
                    entry.sentAt ??
                    history.updatedAt
                }
              : entry
        )
      );
      setPendingCardId(null);
      setError("");
      setStream(null);
      // 作废在跑的那轮：切历史后旧循环不该再往新话题里写东西，
      // 它的 finally 也不该再去改busy
      roundRef.current += 1;
      // 切历史等于换了一个话题，上一轮的排队消息不该跟过来
      setQueued([]);
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
    // 同 restore：新对话要作废在跑的那轮
    roundRef.current += 1;
    // 新对话同理：旧问题的排队尾巴不带进新会话
    setQueued([]);
    resumeRef.current = null;
    // 清空后下一次保存开一条新历史，不覆盖旧的
    historyIdRef.current = null;
    historyTitleRef.current = null;
    setTitle(null);
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
          const directory = directoryFromPrompt(
            session?.terminal
          );
          if (!directory)
            throw new Error(
              "无法识别当前终端目录，请在终端提示符就绪后重试或选择终端执行"
            );
          // 包装命令：先取主机名与当前目录，用于合成终端风格的提示符行，
          // 让执行结果与终端里看到的形态一致（含 `user@host:cwd# 命令`）
          const result = await aiRunCommand(
            {
              host: session?.host ?? "",
              port: session?.port,
              username: session?.username,
              password: session?.password
            },
            commandInDirectory(
              directory,
              `hostname; pwd; echo ---; ${call.command}`
            )
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
            // 请求前自愈协议流：挂起期间发新消息 / 异常中断都可能留下
            // 缺 tool 回复的 assistant 消息，不修则每轮请求都 400
            repairToolMessages(
              messagesRef.current
            ),
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
            },
            true,
            id => {
              streamIdRef.current = id;
            }
          );
        messagesRef.current.push(message);
        setStream(null);
        // 用户点过「停止」：把已收到的部分留成一条回复就收工，
        // 别再往下跑工具循环（那等于无视用户的停止意图）
        if (stoppedRef.current) {
          console.info(
            "[ai] 已停止，不再继续本轮工具循环"
          );
          return;
        }
        if (
          message.content?.trim() ||
          message.reasoning
        ) {
          setEntries(list => [
            ...list,
            {
              kind: "assistant",
              text: message.content ?? "",
              sentAt: Date.now(),
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
          const {
            autoExecute,
            autoApply,
            blacklist
          } = runOptionsRef.current;
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
          // 黑名单命令永不自动执行：即使模型标了只读、开关全开，
          // 也回落为确认卡片，等用户手动放行
          const blacklisted = isBlacklisted(
            card.command,
            blacklist
          );
          if (blacklisted)
            console.info(
              "[ai-exec] 黑名单命令，转人工确认"
            );
          if (
            !blacklisted &&
            (card.isReadOnly
              ? autoExecute
              : autoApply)
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
          // 协议完整性：assistant 消息的每条 tool_call 都必须有配对的
          // tool 消息，否则下一轮请求供应商直接 400。挂起前把本条之后
          // 未处理的 calls 回填「排队中」占位，确认后由模型自行续发
          const yieldedIndex = calls.findIndex(
            call =>
              pendingRef.current.has(call.id)
          );
          for (const call of calls.slice(
            yieldedIndex + 1
          )) {
            messagesRef.current.push({
              role: "tool",
              content:
                "[上一条命令等待用户确认，本条未执行；确认后请重新发起]",
              tool_call_id: call.id
            });
          }
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

  /**
   * 真正发一条：落 entries、写协议流、跑工具循环。
   *
   * 与 `send` 分开是因为出队重发不能再过 busy 检查 —— 那一刻 busy 刚
   * 被本函数（或上一轮）置回 false 前的状态，直接调 send 会被自己的
   * 守卫挡住，队列就卡住不动了。
   */
  const dispatch = useCallback(
    async (
      trimmed: string,
      option: AiModelOption,
      /** 用户上传的图片（data URL） */
      picked: string[]
    ) => {
      // 会话可能在等这一轮的过程中被关掉；没会话就没什么可发的
      if (!session) return;
      // 复制一份：调用方（AiPanel）发完立刻 setAttachments([])，
      // entries 与协议流里存的都不该跟它共享引用
      const images = [...picked];
      setError("");
      // 认领本轮：后续收尾只在本轮仍是当轮时才生效（见 roundRef 注释）
      const round = (roundRef.current += 1);
      setBusy(true);
      setEntries(list => [
        ...list,
        {
          kind: "user",
          text: trimmed,
          sentAt: Date.now(),
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
        // 已被后续轮次（confirm / skip / 停止）接管就别收尾 ——
        // 否则这里的 setBusy(false) 会把新轮的 busy 冲掉，
        // 症状是点完卡片按钮底部发送键立刻退回发送态（见 roundRef 注释）
        // ⚠️ 这里用 if/else 而不是 early return：`return` 写在 finally 里
        // 会吞掉 try 抛出的异常（eslint no-unsafe-finally 也直接报）。
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai] 收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [runLoop, session]
  );

  /**
   * 停止生成。
   *
   * 分两种情形（**不能只看 busy**）：
   *
   * A. `busy` —— 正在流式生成。此时三件事，缺一不可：
   *    ① 置`stoppedRef` —— runLoop 的工具循环据此收工。没有它，模型这一跳
   *    带 tool_calls 的话，循环会接着发下一跳请求，等于无视停止意图；
   *    ② `cancelChatStream` 掐掉后端 HTTP 流 —— 只停前端的话reqwest
   *    还在向网关拉数据，白烧 token；
   *    ③ 手动 `setBusy(false)` —— 后端要等流结束才返回 invoke，不必等它。
   *
   * B. `pendingCardId` —— 正等用户确认工具卡片。这种情况下**没有 HTTP 流**
   *    可掐（`runLoop` 已挂起在 `resumeRef` 上），要停的是「挂起」本身：
   *    不resolve 它runLoop 就永远收不了尾，而 `busy` 已被那行
   *    `setBusy(false)` 置回false（不然卡片上的执行/跳过按钮会一直禁用）。
   *    所以只判`busy` 的话，这一阶段底部按钮会退回发送态 —— 看着像能发
   *    消息，实际什么也不会发生（既没流也没循环）。
   *    做法：把这张卡片标记为已跳过并回填一条 tool 结果，再 `resumeRef`
   *    唤醒 runLoop让它正常收尾（与 `skip` 同一条路径，但不续跑下一跳）。
   *
   * 排队中的消息**不清空**：用户停止只是不想继续这一轮，之前问过的
   * 那几条不该被丢掉。空闲后队列 effect 会把它们接着发出去。
   */
  const stop = useCallback(() => {
    // B. 等确认：没有流可掐，改为收掉挂起本身
    if (!busy && pendingCardId) {
      const held = pendingRef.current.get(
        pendingCardId
      );
      // 同 A：作废挂起的那一轮，否则它被唤醒后跑 finally
      // 又会把状态改回去
      roundRef.current += 1;
      stoppedRef.current = true;
      if (held) {
        pendingRef.current.delete(pendingCardId);
        void executeCard(
          held.call,
          held.toolCallId,
          "background",
          true
        ).then(() => {
          // executeCard 的 skip 分支固定写「用户跳过了这条命令」，
          // 但用户点的是停止。改文案并再刷一次卡片 —— executeCard
          // 末尾那次 setEntries 已经跑完了。
          held.call.error = "用户停止了本轮";
          setEntries(list => [...list]);
          resumeRef.current?.();
        });
        console.info(
          `[ai] 停止：放弃待确认卡片 ${pendingCardId}`
        );
      }
      setPendingCardId(null);
      console.info("[ai] 用户停止（等确认阶段）");
      return;
    }
    if (!busy) return;
    // A. 流式生成中
    stoppedRef.current = true;
    // ⚠️ 必须夺取令牌：否则仍在跑的 runLoop 稍后进finally 时
    // `round === roundRef.current` 仍成立，会把 busy 又set 回true/继续跑
    roundRef.current += 1;
    setBusy(false);
    setStream(null);
    const streamId = streamIdRef.current;
    streamIdRef.current = null;
    if (streamId) void cancelChatStream(streamId);
    else
      console.info(
        "[ai] 停止生成（当前没有进行中的流）"
      );
    console.info("[ai] 用户停止生成");
  }, [busy, pendingCardId, executeCard]);

  /**
   * 新一轮开始前清掉停止标记。
   *
   * 不清的话：用户停止一次之后，之后每一次发送都会被 stoppedRef 挡住
   * 工具循环，表现为"能聊天但 AI 永远不执行命令"，且极难联想到。
   */
  const beginRound = useCallback(() => {
    stoppedRef.current = false;
  }, []);

  const send = useCallback(
    async (
      text: string,
      option: AiModelOption | null,
      /** 用户上传的图片（data URL），可只发图不发消息 */
      images: string[] = []
    ) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;
      if (!session) return;
      if (!option) {
        setError(
          "请先在「模型设置」里配置一个 OpenAI 兼容的供应商和模型"
        );
        return;
      }
      // 记下本轮模型，队列续发时接力用
      optionRef.current = option;
      // AI 在跑 / 等工具确认：不丢消息，排进队列。
      // 之前这里是直接 return —— Enter 键按下去毫无反应，用户无从得知
      // 消息丢了。现在入队并等本轮结束自动续发。
      if (busy || pendingCardId) {
        setQueued(list =>
          enqueueMessage(list, {
            text: trimmed,
            images
          })
        );
        console.info(
          `[ai] 生成中，消息已入队（${busy ? "busy" : "pendingCard"}）`
        );
        return;
      }
      // 真要发这一轮了（不是入队），清掉上一轮的停止标记。
      // 必须放在入队分支**之后**：入队不开始新一轮，若在那儿清，
      // 会把"已停止、队列待续发"的标记提前抹掉
      beginRound();
      await dispatch(trimmed, option, images);
    },
    [
      busy,
      pendingCardId,
      dispatch,
      beginRound,
      session
    ]
  );

  /**
   * 出队续发：把队列里的消息依次发出去。
   *
   * 由 effect 驱动而不是在 confirm/skip 的 finally 里调 —— setBusy(false)
   * 是异步 state，此刻 flushQueue 读到的 busy 仍是 true，会被自己的守卫
   * 挡回去，队列就永远卡住。监听「空闲状态」不依赖调用时机，稳。
   *
   * 一次只发一条 —— 发完若模型又要求工具确认（busy 再次为 true），
   * 剩下的等下一次续发，避免几条消息挤进同一个协议轮次里。
   */
  useEffect(() => {
    if (busy || pendingCardId || !session) return;
    const head = queued[0];
    if (!head) return;
    // option 只在 send/confirm/skip 的入参里出现过，hook 内不存 state；
    // 用最后一次调用留下的 ref 续发，语义上是"接着上一轮继续"
    const option = optionRef.current;
    if (!option) {
      console.warn(
        "[ai] 队列有消息但没有可用模型，已停止自动续发"
      );
      return;
    }
    // 先出队再发：dispatch 是异步的，若发完才出队，续发期间用户
    // 新发的消息会被误当成队首重发一次
    setQueued(list =>
      dequeueMessage(list, head.id)
    );
    console.info(
      `[ai] 队列续发（剩 ${queued.length - 1} 条）`
    );
    void dispatch(head.text, option, head.images);
    // queued 进了依赖：出队后 effect 重跑，若此时不再忙就发下一条
  }, [
    busy,
    pendingCardId,
    queued,
    dispatch,
    session
  ]);

  /** 编辑一条排队消息（同 id 覆盖，不新增条目）。 */
  const updateQueued = useCallback(
    (message: AiQueuedMessage) => {
      setQueued(list =>
        enqueueMessage(list, message)
      );
    },
    []
  );

  /** 丢弃一条排队消息。 */
  const removeQueued = useCallback(
    (id: string) => {
      setQueued(list => dequeueMessage(list, id));
    },
    []
  );

  /**
   * 拖拽换序：把 id 这条挪到 targetId 的位置。
   *
   * 队列本来是严格 FIFO（见上方 send 与续发 effect），用户却希望能调整
   * 顺序 —— 比如连着问三件事时把最关心的排到最后立刻问。所以这里显式
   * 允许重排，续发 effect 取的仍是 queued[0]，重排后自然生效。
   */
  const reorderQueued = useCallback(
    (id: string, targetId: string) => {
      setQueued(list =>
        moveQueued(list, id, targetId)
      );
      console.info(
        `[ai] 队列换序：${id} → ${targetId}`
      );
    },
    []
  );

  /** 手柄键盘换序（上移/下移一位）。 */
  const nudgeQueuedBy = useCallback(
    (id: string, delta: -1 | 1) => {
      setQueued(list =>
        nudgeQueued(list, id, delta)
      );
      console.info(
        `[ai] 队列键盘换序：${id} ${
          delta < 0 ? "上移" : "下移"
        }`
      );
    },
    []
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
      // 确认也算一轮"正在跑"，队列续发接力同一个模型
      optionRef.current = option;
      // 用户主动确认 = 想让这轮继续，清掉停止标记
      beginRound();
      // 认领新轮次：上一轮 runLoop 被下面的 resumeRef 唤醒后会立刻
      // return 并跑它自己的 finally，没有令牌的话 busy 会被它冲回false
      const round = (roundRef.current += 1);
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
        // if/else 而非 early return：return 写在 finally 里会吞异常
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai] confirm 收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [executeCard, runLoop, beginRound]
  );

  /** 跳过一张待确认的卡片：以"用户跳过"回填后继续循环。 */
  const skip = useCallback(
    async (
      cardId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(cardId);
      if (!held || !option) return;
      optionRef.current = option;
      // 同 confirm：用户主动跳过 = 想让这轮继续
      beginRound();
      const round = (roundRef.current += 1);
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
        // if/else 而非 early return：return 写在 finally 里会吞异常
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai] skip 收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [executeCard, runLoop, beginRound]
  );

  return {
    entries,
    busy,
    pendingCardId,
    error,
    stream,
    /** 当前对话标题（null = 还没起标题，新对话刚点开时）。 */
    title,
    /** 排队中的用户消息（AI 在跑 / 等确认时发送的）。 */
    queued,
    send,
    stop,
    confirm,
    skip,
    clear,
    restore,
    renameCurrent,
    updateQueued,
    removeQueued,
    reorderQueued,
    nudgeQueuedBy
  };
}
