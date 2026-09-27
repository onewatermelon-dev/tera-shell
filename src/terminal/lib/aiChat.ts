import {
  useCallback,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  loadProviders,
  type ModelEntry,
  type ModelProvider
} from "@/settings/lib/modelProviders";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

/**
 * AI 聊天的交互引擎：workspace 上下文注入 + run_command 工具循环。
 *
 * 借鉴 WisdomSSH 的交互模型 —— 模型通过 run_command 工具在当前服务器
 * 执行命令；只读命令自动执行，读写命令生成执行卡片等用户确认。
 * 会话只保存在内存里（应用关闭即消失），不落盘。
 */

/** 一条用户 / 助手可见消息。 */
export type AiChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; call: AiToolCall };

/** 一次命令执行卡片的状态。 */
export type AiToolCall = {
  id: string;
  command: string;
  /** 模型给出的执行说明，展示给用户 */
  question: string;
  /** true = 只读（自动执行）；false = 读写（等用户点执行） */
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
type ProtocolMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
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

/** 工具结果回填给模型的上限：超长保留尾部（诊断价值在尾部）。 */
const TOOL_RESULT_LIMIT = 8000;

const SYSTEM_PROMPT = `你是终端应用里的运维 AI 助手，运行在用户的 SSH 服务器环境中。
你可以通过 run_command 工具在当前服务器上执行命令：
- command：要执行的命令，在用户主目录下以登录 shell 运行；每个命令独立，需要操作其他目录请用绝对路径或 cd xxx && 组合。
- question：一句话向用户解释这条命令做什么。
- is_read_only：纯读取类命令（查看、搜索、统计）设为 true 会被自动执行；任何会修改服务器状态的命令（写文件、安装、重启、删除等）必须设为 false，等待用户确认。
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
        "纯读取类命令为 true（自动执行），会修改服务器状态必须为 false（等待用户确认）"
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
  buildBody: (option, messages) => ({
    model: option.model.name.trim(),
    messages,
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
      choices?: { message?: ProtocolMessage }[];
    };
    const message = parsed.choices?.[0]?.message;
    if (!message) {
      throw new Error("模型响应里没有消息内容");
    }
    return message;
  }
};

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
        content: message.content ?? ""
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
        id?: string;
        name?: string;
        input?: unknown;
      }>;
    };
    const content = (parsed.content ?? [])
      .filter(block => block.type === "text")
      .map(block => block.text ?? "")
      .join("");
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
          }
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

/** 按供应商的 API 格式发一次对话补全，统一返回 OpenAI 消息形态。 */
async function chatCompletion(
  option: AiModelOption,
  messages: ProtocolMessage[]
): Promise<ProtocolMessage> {
  const adapter = adapterOf(
    option.provider.apiFormat
  );
  const base = option.provider.baseUrl
    .trim()
    .replace(/\/+$/, "");
  const text = await invoke<string>(
    "http_post_text",
    {
      url: adapter.endpoint(base),
      headers: adapter.headers(
        option.provider.apiKey
      ),
      body: adapter.buildBody(option, messages)
    }
  );
  return adapter.parse(text);
}

/** 工具结果回填前的截断：保留尾部并注明。 */
export function trimToolOutput(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string {
  const raw = `退出码: ${result.exitCode}\n${result.stdout}${
    result.stderr
      ? `\n[stderr]\n${result.stderr}`
      : ""
  }`;
  if (raw.length <= TOOL_RESULT_LIMIT) return raw;
  return `[输出过长，已截断，保留尾部 ${TOOL_RESULT_LIMIT} 字符]\n${raw.slice(
    -TOOL_RESULT_LIMIT
  )}`;
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
  session: OpenSession | undefined
) {
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

  const clear = useCallback(() => {
    messagesRef.current = [];
    pendingRef.current.clear();
    setEntries([]);
    setPendingCardId(null);
    setError("");
    resumeRef.current = null;
  }, []);

  /** 执行一张卡片并把结果回填进协议流。 */
  const executeCard = useCallback(
    async (
      call: AiToolCall,
      toolCallId: string,
      skip = false
    ) => {
      let content: string;
      if (skip) {
        call.state = "failed";
        call.error = "用户跳过了这条命令";
        content = "[用户跳过了这条命令，未执行]";
      } else {
        call.state = "running";
        setEntries(list => [...list]);
        try {
          const result = await aiRunCommand(
            {
              host: session?.host ?? "",
              port: session?.port,
              username: session?.username,
              password: session?.password
            },
            call.command
          );
          call.state =
            result.exitCode === 0
              ? "done"
              : "failed";
          call.stdout = result.stdout;
          call.stderr = result.stderr;
          call.exitCode = result.exitCode;
          content = trimToolOutput(result);
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
        const message = await chatCompletion(
          option,
          messagesRef.current
        );
        messagesRef.current.push(message);
        if (message.content?.trim()) {
          setEntries(list => [
            ...list,
            {
              kind: "assistant",
              text: message.content ?? ""
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
          if (card.isReadOnly) {
            await executeCard(card, toolCallId);
            continue;
          }
          // 读写命令：登记后暂停循环，等用户点执行 / 跳过
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
          // runLoop 接管剩余循环，这里直接收尾
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
      option: AiModelOption | null
    ) => {
      const trimmed = text.trim();
      if (!trimmed || busy || !session) return;
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
        { kind: "user", text: trimmed }
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
        content: `${trimmed}\n\n${workspaceContext(session)}`
      });
      try {
        await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
      }
    },
    [busy, runLoop, session]
  );

  /** 确认执行一张待确认的读写卡片，随后继续工具循环。 */
  const confirm = useCallback(
    async (
      cardId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(cardId);
      if (!held || !option) return;
      setBusy(true);
      pendingRef.current.delete(cardId);
      resumeRef.current?.();
      await executeCard(
        held.call,
        held.toolCallId
      );
      try {
        await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
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
        true
      );
      try {
        await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
      }
    },
    [executeCard, runLoop]
  );

  return {
    entries,
    busy,
    pendingCardId,
    error,
    send,
    confirm,
    skip,
    clear
  };
}
