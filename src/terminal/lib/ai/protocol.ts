/**
 * AI 对话的协议层：内部流转的消息形态、工具调用卡片、轮次令牌与
 * 协议自愈 / 输出截断等纯函数。
 *
 * 从 aiChat.ts 拆出。这里只放类型与无副作用的纯函数，不碰 React
 * 与 Tauri invoke。
 */

/** 执行卡片上命令的执行方式：terminal = 写入活动会话终端；background = 独立 exec 通道。 */
export type ExecCardMode =
  "terminal" | "background";

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

/**
 * 轮次令牌：判断某次异步循环的收尾是否还有权改动共享状态。
 *
 * 背景见 useAiChat 里的 `roundRef` 注释 —— 用户在卡片上点「执行 / 跳过」时，
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

/** 工具结果 / 卡片展示的截断：超长保留尾部，并按 WisdomSSH 的格式注明。 */
export function trimToolOutput(
  raw: string
): string {
  if (raw.length <= TOOL_RESULT_LIMIT) return raw;
  return `[内容太长，已截断。原始长度: ${raw.length} 字符，显示最后 ${TOOL_RESULT_LIMIT} 字符]\n${raw.slice(
    -TOOL_RESULT_LIMIT
  )}`;
}

/** 工具结果回填给模型的上限：超长保留尾部（诊断价值在尾部）。 */
const TOOL_RESULT_LIMIT = 10000;

/**
 * 解析包装命令（`hostname; pwd; echo ---; 原命令`）的输出头部。
 *
 * 后台 exec 通道会把主机名与当前目录包在输出最前面（见 cardExec 的
 * 包装命令），这里拆出来供合成终端风格的提示符行。
 */
export function parseWrappedOutput(
  stdout: string
): {
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
