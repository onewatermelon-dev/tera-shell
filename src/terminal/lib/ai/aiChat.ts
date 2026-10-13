/**
 * AI 聊天的交互引擎：workspace 上下文注入 + run_command 工具循环。
 *
 * 借鉴 WisdomSSH 的交互模型 —— 模型通过 run_command 工具在当前服务器
 * 执行命令；「自动执行 / 自动应用」开关决定卡片自动执行还是等用户确认。
 * 会话只保存在内存里（应用关闭即消失），不落盘。
 *
 * 本文件是 ai/ 模块的门面（facade）：纯函数与协议细节已拆到同目录的
 * queue / protocol / tools / adapters / stream / cardExec，React 状态
 * 按簇拆到 useAiQueue（排队队列）与 useAiHistory（历史与标题），这里只留
 * useAiChat 这个 hook 的核心：工具循环（runLoop）与发送 / 停止 / 确认 /
 * 跳过，并原样再导出此前的公开 API —— 调用方（AiPanel、aiExplain、测试等）
 * 的导入路径无需改动。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type { OpenSession } from "../session/terminalTypes";
import {
  ownsRound,
  repairToolMessages,
  type AiChatEntry,
  type AiFileCall,
  type AiToolCall,
  type ExecCardMode,
  type ProtocolMessage
} from "./protocol";
import {
  isBlacklisted,
  parseFileToolArguments,
  parseToolArguments,
  type AiModelOption
} from "./tools";
import {
  streamChatCompletion,
  cancelChatStream
} from "./stream";
import { executeToolCard } from "./cardExec";
import { executeFileCall } from "./fileTransfer";
import {
  TOOL_DOWNLOAD_FILE,
  TOOL_UPLOAD_FILE
} from "./adapters";
import {
  SYSTEM_PROMPT,
  workspaceContext
} from "./promptContext";
import { useAiQueue } from "./useAiQueue";
import { useAiHistory } from "./useAiHistory";

// 提示词与 workspace 上下文块住在 promptContext（纯函数，可单测），
// 这里原样再导出保持调用方导入路径不变
export { SYSTEM_PROMPT } from "./promptContext";

// 面板偏好（选中模型/执行开关/黑名单）落在数据目录的 ai_prefs.json，
// 这里原样转发，AiPanel 等调用方保持原导入路径不变
export {
  loadSelectedModel,
  saveSelectedModel,
  loadRunFlag,
  saveRunFlag,
  loadBlacklist,
  saveBlacklist
} from "./aiPrefs";

// ---- facade：以下导出与此前 aiChat.ts 的公开 API 一致 ----
export {
  enqueueMessage,
  dequeueMessage,
  moveQueued,
  nudgeQueued,
  type AiQueuedMessage
} from "./queue";
export {
  ownsRound,
  repairToolMessages,
  trimToolOutput,
  parseWrappedOutput,
  type AiChatEntry,
  type AiFileCall,
  type AiToolCall,
  type ExecCardMode,
  type FileTransferDirection,
  type ProtocolMessage,
  type StreamAccumulator,
  type StreamDelta
} from "./protocol";
export {
  commandInDirectory,
  directoryFromPrompt,
  isBlacklisted,
  isAbsoluteRemotePath,
  listOpenAiModels,
  parseFileToolArguments,
  parseToolArguments,
  type AiModelOption
} from "./tools";
export {
  anthropicAdapter,
  responsesAdapter,
  TOOL_DOWNLOAD_FILE,
  TOOL_UPLOAD_FILE,
  TOOL_RUN_COMMAND
} from "./adapters";
export {
  cancelChatStream,
  streamChatCompletion
} from "./stream";
export {
  executeFileCall,
  remoteFileName
} from "./fileTransfer";

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
  // 排队队列：增删改序住在 useAiQueue（纯函数在 queue.ts），
  // 续发 effect 留在本文件（要同时看 busy / pendingCardId / dispatch）
  const queue = useAiQueue();
  const { queued } = queue;
  // 解构成员函数供回调 / effect 引用：queue 对象每渲染新建，整个进 deps
  // 会让 send 与续发 effect 每渲染重建；这几个函数自身是 useCallback，稳定
  const {
    enqueue: enqueueQueued,
    dequeue: dequeueQueued,
    clear: clearQueued
  } = queue;
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
  /**
   * 挂起中卡片的执行信息，确认时取用。
   *
   * 用判别联合而不是两个 Map：一次只挂起一张卡，两个 Map 意味着 confirm /
   * skip 里要「先查命令表、没有再查传输表」，漏一处就是点按钮没反应。
   */
  const pendingRef = useRef<
    Map<
      string,
      | {
          kind: "tool";
          call: AiToolCall;
          toolCallId: string;
        }
      | {
          kind: "file";
          call: AiFileCall;
          toolCallId: string;
        }
    >
  >(new Map());
  const [error, setError] = useState("");
  /** 正在流式生成的助手消息（null = 没有进行中的流） */
  const [stream, setStream] = useState<{
    text: string;
    reasoning: string;
  } | null>(null);

  /**
   * 恢复历史 / 开新对话前重置「在跑的那轮」。
   *
   * 五件事都来自循环状态（待确认卡片、错误、流、轮次令牌、队列），
   * 由门面注入给 useAiHistory —— 那里只做历史本身。
   */
  const resetLiveState = useCallback(() => {
    setPendingCardId(null);
    setError("");
    setStream(null);
    roundRef.current += 1;
    clearQueued();
  }, [clearQueued]);

  /** 清空对话还要释放挂起的卡片与循环句柄（恢复不清，见 useAiHistory）。 */
  const releasePending = useCallback(() => {
    pendingRef.current.clear();
    resumeRef.current = null;
  }, []);

  // 历史持久化与标题：自动保存 effect / renameCurrent / restore / clear
  const history = useAiHistory({
    session,
    entries,
    busy,
    messagesRef,
    setEntries,
    resetLiveState,
    releasePending
  });

  /** 执行一张卡片并把结果回填进协议流。mode 见 ExecCardMode。 */
  const executeCard = useCallback(
    async (
      call: AiToolCall,
      toolCallId: string,
      mode: ExecCardMode = "background",
      skip = false
    ) => {
      const content = await executeToolCard(
        call,
        toolCallId,
        mode,
        skip,
        session,
        () => setEntries(list => [...list])
      );
      messagesRef.current.push({
        role: "tool",
        content,
        tool_call_id: toolCallId
      });
    },
    [session]
  );

  /**
   * 执行一张文件传输卡片并把结果回填进协议流。
   *
   * 与 `executeCard` 平级而非塞进去：命令卡片要选 terminal / background
   * 两种执行通道，传输卡片没有这个概念（必然走 SFTP + 系统弹窗），
   * 硬塞会让 mode 参数对不上语义。
   */
  const executeFileCard = useCallback(
    async (
      call: AiFileCall,
      toolCallId: string,
      skip = false
    ) => {
      const content = await executeFileCall(
        call,
        toolCallId,
        skip,
        session,
        () => setEntries(list => [...list])
      );
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
          const toolCallId = call.id;
          const toolName = call.function.name;
          // ---- 文件传输工具：结构与命令卡片不同，单独分支 ----
          // ⚠️ 必须先判工具名：`parseToolArguments` 只认 command 字段，
          // 拿传输工具的参数去解会得到 null，白白回填一条「参数解析失败」。
          if (
            toolName === TOOL_UPLOAD_FILE ||
            toolName === TOOL_DOWNLOAD_FILE
          ) {
            const fileArgs =
              parseFileToolArguments(
                call.function.arguments
              );
            if (!fileArgs) {
              messagesRef.current.push({
                role: "tool",
                content:
                  "[文件路径无效或不是绝对路径，请给出服务器上的绝对路径后重试]",
                tool_call_id: toolCallId
              });
              continue;
            }
            const fileCall: AiFileCall = {
              id: toolCallId,
              direction:
                toolName === TOOL_UPLOAD_FILE
                  ? "upload"
                  : "download",
              remotePath: fileArgs.remotePath,
              question: fileArgs.question,
              state: "pending"
            };
            console.info(
              "[ai-file]",
              fileCall.direction,
              fileCall.remotePath
            );
            setEntries(list => [
              ...list,
              { kind: "file", call: fileCall }
            ]);
            // 传输**一律等用户确认**，不参与自动执行 / 自动应用：
            // 它要读写用户的本地磁盘，且必然弹系统框自动弹窗也不合语义
            pendingRef.current.set(toolCallId, {
              kind: "file",
              call: fileCall,
              toolCallId
            });
            setPendingCardId(toolCallId);
            yielded = true;
            break;
          }
          const parsed = parseToolArguments(
            call.function.arguments
          );
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
            kind: "tool",
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
        // 判别联合：传输卡片走自己的执行器（skip 分支同样不弹框）
        const skipped =
          held.kind === "file"
            ? executeFileCard(
                held.call,
                held.toolCallId,
                true
              )
            : executeCard(
                held.call,
                held.toolCallId,
                "background",
                true
              );
        void skipped.then(() => {
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
  }, [
    busy,
    pendingCardId,
    executeCard,
    executeFileCard
  ]);

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
        enqueueQueued({
          text: trimmed,
          images
        });
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
      session,
      enqueueQueued
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
    dequeueQueued(head.id);
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
    session,
    dequeueQueued
  ]);

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
      // 判别联合分派：传输卡片没有执行通道之分，mode 直接忽略
      if (held.kind === "file") {
        await executeFileCard(
          held.call,
          held.toolCallId
        );
      } else {
        await executeCard(
          held.call,
          held.toolCallId,
          mode
        );
      }
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
    [
      executeCard,
      executeFileCard,
      runLoop,
      beginRound
    ]
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
      if (held.kind === "file") {
        await executeFileCard(
          held.call,
          held.toolCallId,
          true
        );
      } else {
        await executeCard(
          held.call,
          held.toolCallId,
          "background",
          true
        );
      }
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
    [
      executeCard,
      executeFileCard,
      runLoop,
      beginRound
    ]
  );

  return {
    entries,
    busy,
    pendingCardId,
    error,
    stream,
    /** 当前对话标题（null = 还没起标题，新对话刚点开时）。 */
    title: history.title,
    /** 排队中的用户消息（AI 在跑 / 等确认时发送的）。 */
    queued: queue.queued,
    send,
    stop,
    confirm,
    skip,
    clear: history.clear,
    restore: history.restore,
    renameCurrent: history.renameCurrent,
    updateQueued: queue.enqueue,
    removeQueued: queue.dequeue,
    reorderQueued: queue.reorder,
    nudgeQueuedBy: queue.nudgeBy
  };
}
