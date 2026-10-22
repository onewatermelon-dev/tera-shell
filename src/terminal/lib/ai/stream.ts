/**
 * 流式对话补全与取消：经 Rust SSE 桥（ai_chat_stream 命令）拉取模型
 * 响应，delta 实时回调，结束后返回组装完的助手消息。
 *
 * 从 aiChat.ts 拆出。协议转换在 adapters.ts，这里只负责事件桥接。
 */
import { logError } from "@/shared/lib/log";
import { invoke } from "@tauri-apps/api/core";
import type { AiModelOption } from "./tools";
import {
  accumulatorOf,
  adapterOf
} from "./adapters";
import type {
  AiUsage,
  ProtocolMessage,
  StreamDelta
} from "./protocol";

/**
 * 流式对话补全：请求体加 stream:true 走 Rust SSE 桥，delta 通过
 * onDelta 实时回调（content / reasoning 增量），结束后返回组装完
 * 整的助手消息（与 chatCompletion 同形态，协议流无缝衔接）与本次
 * 调用的 token 用量（模型没给则 undefined）。
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
  onStreamId?: (streamId: string) => void,
  /**
   * 流正常结束时的回调（系统通知用）。
   *
   * 只在**成功结束**时触发：抛异常那条路（网络断了、用户点了停止）
   * 不算「回答完成」，通知说「AI 回答完成」会误导。
   */
  onDone?: (info: {
    elapsedMs: number;
    preview: string;
  }) => void
): Promise<{
  message: ProtocolMessage;
  usage: AiUsage | undefined;
}> {
  const adapter = adapterOf(
    option.provider.apiFormat
  );
  const base = option.provider.baseUrl
    .trim()
    .replace(/\/+$/, "");
  const streamId = `ai-stream-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  // 计时起点放在 streamId 之后：用户等模型「正在思考」的那段时间
  // 也算在耗时里，通知里报的时长才与用户体感一致
  const startedAt = Date.now();
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
    // OpenAI 系流式**默认不返回 usage**，要显式要一份（最后一个 chunk
    // 才给）。⚠️ 只给 openai 格式加：Anthropic / Responses 不认这个字段，
    // 滥加有被 400 的风险。Anthropic 的用量在 message_start /
    // message_delta 事件里，Responses 在 response.completed 里，都无需
    // 请求端配合。
    const body: Record<string, unknown> = {
      ...built,
      stream: true
    };
    if (option.provider.apiFormat === "openai")
      body.stream_options = {
        include_usage: true
      };
    await invoke("ai_chat_stream", {
      streamId,
      url: adapter.endpoint(base),
      headers: adapter.headers(
        option.provider.apiKey
      ),
      body
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
    const message = accumulator.finalize();
    // 长回答结束通知：开关、窗口焦点由 useNotifications 统一判，
    // 这里只负责「回答好了、这句有多长、花了多久」
    onDone?.({
      elapsedMs: Date.now() - startedAt,
      preview: extractPreview(message)
    });
    return {
      message,
      usage: accumulator.usage()
    };
  } finally {
    unlisten();
  }
}

/** 取回答开头的一小段，供通知里认出「问的是什么」。 */
function extractPreview(
  message: ProtocolMessage
): string {
  const text =
    message.role === "assistant"
      ? message.content
      : "";
  const plain = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*`>[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, 60);
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
    logError("[ai] 停止生成失败", reason);
  }
}
