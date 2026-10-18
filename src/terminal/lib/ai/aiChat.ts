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
 * 跳过，以及多步计划的批准 / 取消 / 逐步执行（approvePlan / rejectPlan），
 * 并原样再导出此前的公开 API —— 调用方（AiPanel、aiExplain、测试等）
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
  type AiFileEditCall,
  type AiPlanCall,
  type AiPlanStep,
  type AiQuestionCall,
  type AiToolCall,
  type AiUsage,
  type ExecCardMode,
  type ProtocolMessage
} from "./protocol";
import {
  isBlacklisted,
  parseAskToolArguments,
  parseEditToolArguments,
  parseFileToolArguments,
  parsePlanToolArguments,
  parseToolArguments,
  planStepAutoRuns,
  shouldAutoRun,
  type AiModelOption
} from "./tools";
import {
  streamChatCompletion,
  cancelChatStream
} from "./stream";
import { executeToolCard } from "./cardExec";
import { cancelAiExec } from "./aiExec";
import { executeFileCall } from "./fileTransfer";
import {
  readRemoteFileText,
  writeRemoteFileText
} from "./fileEditExec";
import {
  applyEdits,
  buildHunks,
  computeLineDiff,
  FILE_DIFF_LIMIT
} from "./fileDiff";
import {
  TOOL_ASK_QUESTIONS,
  TOOL_DOWNLOAD_FILE,
  TOOL_EDIT_FILE,
  TOOL_PROPOSE_PLAN,
  TOOL_RUN_COMMAND,
  TOOL_UPLOAD_FILE
} from "./adapters";
import {
  SYSTEM_PROMPT,
  workspaceContext
} from "./promptContext";
import {
  extractTerminalRefs,
  formatTerminalRefBlock,
  readTerminalLines
} from "./terminalRefs";
import { useAiQueue } from "./useAiQueue";
import { useAiHistory } from "./useAiHistory";
import { emitAiDone } from "@/lib/notifyBridge";

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
  type AiDiffHunk,
  type AiDiffLine,
  type AiFileCall,
  type AiFileEdit,
  type AiFileEditCall,
  type AiPlanCall,
  type AiPlanStep,
  type AiQuestion,
  type AiQuestionCall,
  type AiToolCall,
  type AiUsage,
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
  parseAskToolArguments,
  parseEditToolArguments,
  parseFileToolArguments,
  parsePlanToolArguments,
  parseToolArguments,
  planStepAutoRuns,
  shellQuote,
  shouldAutoRun,
  type AiModelOption,
  type PlanToolStep
} from "./tools";
export {
  anthropicAdapter,
  responsesAdapter,
  TOOL_ASK_QUESTIONS,
  TOOL_DOWNLOAD_FILE,
  TOOL_EDIT_FILE,
  TOOL_PROPOSE_PLAN,
  TOOL_RUN_COMMAND,
  TOOL_UPLOAD_FILE
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
   *
   * `plan` 是多步计划卡（批准/取消整份计划）；工具条目上的 `planStep` +
   * `settle` 是计划里的单步命令 —— 执行完不续跑 runLoop，只唤醒计划循环
   * （见 approvePlan 的注释）。
   */
  const pendingRef = useRef<
    Map<
      string,
      | {
          kind: "tool";
          call: AiToolCall;
          toolCallId: string;
          /** 计划里的单步：确认/跳过后只唤醒计划循环，不收尾整轮 */
          planStep?: boolean;
          /** 计划里这条步骤的展示对象（确认后先置 running 再执行） */
          step?: AiPlanStep;
          /** 唤醒计划循环；入参 true = 该步骤被跳过/中止 */
          settle?: (skipped: boolean) => void;
        }
      | {
          kind: "file";
          call: AiFileCall;
          toolCallId: string;
        }
      | {
          kind: "plan";
          call: AiPlanCall;
          toolCallId: string;
        }
      | {
          kind: "question";
          call: AiQuestionCall;
          toolCallId: string;
        }
      | {
          kind: "edit";
          call: AiFileEditCall;
          toolCallId: string;
        }
    >
  >(new Map());
  /**
   * 同一批 tool_calls 里被「挂起」挡住的后续命令。
   *
   * ⚠️ 模型经常一条消息里发 2-3 条 run_command。旧实现只认第一条，其余
   * 回填「本条未执行，确认后请重新发起」就算了 —— 用户看到的是
   * 「第二条命令又没执行成功」，模型也以为自己被挂起了（2026-10-18 报）。
   * 现在把它们排队：确认完当前卡片后按顺序跑完，需要确认的逐条弹卡，
   * 都处理完再回到模型（模型一次拿到全部结果）。
   */
  const queuedToolCallsRef = useRef<
    { call: AiToolCall; toolCallId: string }[]
  >([]);
  /**
   * 计划执行中止标记（用户点停止 / 切历史 / 关面板）。
   *
   * 计划循环每步之间查它；单步确认挂起时由 stop 置位，executeCard 的
   * skip 分支跑完后循环自然收摊。
   */
  const planAbortRef = useRef(false);
  /** 是否有计划正在执行（stop 据此区分「掐流」与「停计划」）。 */
  const planRunningRef = useRef(false);
  /**
   * 计划里正在执行的那一步。
   *
   * 自动执行的步骤没有挂起卡片，stop 时靠它找到该把哪一行标成
   * 「已停止」—— 不标的话，后端命令取消前（最长 1 秒）界面毫无
   * 反馈，用户以为停止没生效。
   */
  const planCurrentStepRef =
    useRef<AiPlanStep | null>(null);
  /**
   * 正在后台执行的那条命令的 exec id。
   *
   * 停止时交给后端 `ai_exec_cancel` 置取消标志 —— 否则前端停了，
   * 后端还在 read 上堵到命令结束或超时（用户看到「点了暂停，
   * 命令还在执行中」）。
   */
  const runningExecIdRef = useRef<string | null>(
    null
  );
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
    // 在跑的计划循环收摊：否则它会继续往已切走的话题里写结果
    planAbortRef.current = true;
  }, [clearQueued]);

  /** 清空对话还要释放挂起的卡片与循环句柄（恢复不清，见 useAiHistory）。 */
  const releasePending = useCallback(() => {
    // 计划里挂起的单步：先唤醒再清表，否则计划循环永远等在 settle 上
    for (const held of pendingRef.current.values())
      if (held.kind === "tool" && held.planStep) {
        planAbortRef.current = true;
        held.settle?.(true);
      }
    pendingRef.current.clear();
    // 同批排队的命令也一并丢弃：会话已清空 / 切走，留着会在下次
    // confirm 时莫名其妙跑起来
    queuedToolCallsRef.current = [];
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
      // 后台执行登记 exec id：停止时靠它让后端掐掉这条命令
      // （终端模式写进 PTY，后端没有可取消的通道，不登记）
      const execId =
        mode === "background" && !skip
          ? crypto.randomUUID()
          : null;
      if (execId)
        runningExecIdRef.current = execId;
      try {
        const content = await executeToolCard(
          call,
          toolCallId,
          mode,
          skip,
          session,
          () => setEntries(list => [...list]),
          execId ?? undefined
        );
        messagesRef.current.push({
          role: "tool",
          content,
          tool_call_id: toolCallId
        });
      } finally {
        if (runningExecIdRef.current === execId)
          runningExecIdRef.current = null;
      }
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

  /**
   * 依次执行排队中的同批命令。
   *
   * 规则与 runLoop 里一致：黑名单永不自动执行；只读看 autoExecute，
   * 读写看 autoApply。轮到一条需要确认的就**弹卡挂起**并返回 true
   * （调用方不要再跑 runLoop，等用户点第二张卡）；全部跑完返回 false。
   */
  const drainQueuedCommands =
    useCallback(async (): Promise<boolean> => {
      while (
        queuedToolCallsRef.current.length > 0
      ) {
        const next =
          queuedToolCallsRef.current.shift();
        if (!next) break;
        const {
          autoExecute,
          autoApply,
          blacklist
        } = runOptionsRef.current;
        if (
          !shouldAutoRun(next.call, {
            autoExecute,
            autoApply,
            blacklist
          })
        ) {
          console.info(
            "[ai-exec] 队列中的命令需要确认：",
            next.call.command
          );
          setEntries(list => [
            ...list,
            { kind: "tool", call: next.call }
          ]);
          pendingRef.current.set(
            next.toolCallId,
            {
              kind: "tool",
              call: next.call,
              toolCallId: next.toolCallId
            }
          );
          setPendingCardId(next.toolCallId);
          return true;
        }
        console.info(
          "[ai-exec] 队列续跑：",
          next.call.command
        );
        await executeCard(
          next.call,
          next.toolCallId
        );
      }
      return false;
    }, [executeCard]);

  /** 工具循环：从当前协议流继续请求模型，直到出现普通回复或等确认。 */
  const runLoop = useCallback(
    async (option: AiModelOption) => {
      const MAX_HOPS = 8;
      // 纯工具调用跳（模型只回 tool_calls、没正文也没思考）不建条目，
      // 其 token 用量结转到下一条可见回复，别让成本可视漏账
      let carriedUsage: AiUsage | undefined;
      for (
        let hop = 0;
        hop < MAX_HOPS;
        hop += 1
      ) {
        const startedAt = Date.now();
        // 流式：先挂一条空的流式条目，delta 到达就地追加，结束后落为正式条目
        setStream({ text: "", reasoning: "" });
        // 纯工具调用跳（无正文无思考）不建条目，它的用量结转到下一条
        // 可见回复上 —— 否则那部分 token 在成本可视里凭空消失
        const { message, usage } =
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
            },
            info => {
              // 通知只在「本轮真正产出可见回复」时发：下面若因用户点了
              // 停止而提前收工，那不是「回答完成」，不该弹通知
              // 通知走桥接而非 props：handler 由 App 层的 useNotifications
              // 注册，这里只需 emit（见 lib/notifyBridge 的说明）
              if (!stoppedRef.current)
                emitAiDone(
                  // label 形如「供应商 / 模型」，正是通知里
                  // 让用户认得出是哪个会话所需的信息
                  option.label,
                  info.elapsedMs,
                  info.preview
                );
            }
          );
        if (usage)
          carriedUsage = carriedUsage
            ? {
                inputTokens:
                  carriedUsage.inputTokens +
                  usage.inputTokens,
                outputTokens:
                  carriedUsage.outputTokens +
                  usage.outputTokens,
                ...(carriedUsage.cachedInputTokens ||
                usage.cachedInputTokens
                  ? {
                      cachedInputTokens:
                        (carriedUsage.cachedInputTokens ??
                          0) +
                        (usage.cachedInputTokens ??
                          0)
                    }
                  : {})
              }
            : usage;
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
          // 结转用量并清空：这一跳连同之前没建条目的工具跳，
          // 成本都算在这条回复头上
          const entryUsage = carriedUsage
            ? {
                ...carriedUsage,
                modelId: option.modelId
              }
            : undefined;
          carriedUsage = undefined;
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
                : {}),
              ...(entryUsage
                ? { usage: entryUsage }
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
          // ---- 多步计划：只登记不执行，等用户在计划卡上批准 ----
          // 与文件传输卡片同等级别：整份计划是一次用户决策，不参与
          // 自动执行 / 自动应用开关（那两只管单条命令）
          if (toolName === TOOL_PROPOSE_PLAN) {
            const planArgs =
              parsePlanToolArguments(
                call.function.arguments
              );
            if (!planArgs) {
              // 参数不合法也要回填 tool 消息，否则协议流断裂
              messagesRef.current.push({
                role: "tool",
                content:
                  "[计划参数不完整：需要标题、摘要，以及至少一步带标题和命令的步骤（最多 12 步）。请重新给出完整计划]",
                tool_call_id: toolCallId
              });
              continue;
            }
            const plan: AiPlanCall = {
              id: toolCallId,
              title: planArgs.title,
              summary: planArgs.summary,
              steps: planArgs.steps.map(
                (step, index) => ({
                  id: `${toolCallId}#${index}`,
                  title: step.title,
                  ...(step.detail
                    ? { detail: step.detail }
                    : {}),
                  command: step.command,
                  isReadOnly: step.isReadOnly,
                  state: "pending" as const
                })
              ),
              state: "pending"
            };
            console.info(
              "[ai-plan] 待批准计划：",
              plan.title,
              "步骤数",
              plan.steps.length
            );
            setEntries(list => [
              ...list,
              { kind: "plan", call: plan }
            ]);
            pendingRef.current.set(toolCallId, {
              kind: "plan",
              call: plan,
              toolCallId
            });
            setPendingCardId(toolCallId);
            yielded = true;
            break;
          }
          // ---- 反问：信息不足时向用户提问，答完才继续 ----
          // 与计划同等级别：整组问题是一次用户交互，不参与自动执行开关
          if (toolName === TOOL_ASK_QUESTIONS) {
            const askArgs = parseAskToolArguments(
              call.function.arguments
            );
            if (!askArgs) {
              // 参数不合法也要回填 tool 消息，否则协议流断裂
              messagesRef.current.push({
                role: "tool",
                content:
                  "[提问参数不完整：至少一题，每题需要 id、问题文字与至少一个候选项，且 id 不可重复。请重新提问]",
                tool_call_id: toolCallId
              });
              continue;
            }
            const questions: AiQuestionCall = {
              id: toolCallId,
              title: askArgs.title,
              questions: askArgs.questions,
              answers: {},
              state: "pending"
            };
            console.info(
              "[ai-ask] 待回答提问：",
              questions.title,
              "题数",
              questions.questions.length
            );
            setEntries(list => [
              ...list,
              {
                kind: "question",
                call: questions
              }
            ]);
            pendingRef.current.set(toolCallId, {
              kind: "question",
              call: questions,
              toolCallId
            });
            setPendingCardId(toolCallId);
            yielded = true;
            break;
          }
          // ---- 文件改动：先出 diff 卡，批准后才写回 ----
          // 与计划 / 反问同级：整次改动是一次用户决策，没有自动应用
          // （开了「自动应用」也不放行 —— 无审查的写文件违背本卡片的
          // 存在意义）
          if (toolName === TOOL_EDIT_FILE) {
            const editArgs =
              parseEditToolArguments(
                call.function.arguments
              );
            if (!editArgs) {
              // 参数不合法也要回填 tool 消息，否则协议流断裂
              messagesRef.current.push({
                role: "tool",
                content:
                  "[参数不完整：需要绝对路径、说明，以及至少一处带原文与新文本的替换块。请重新给出]",
                tool_call_id: toolCallId
              });
              continue;
            }
            const editCall: AiFileEditCall = {
              id: toolCallId,
              path: editArgs.path,
              summary: editArgs.summary,
              edits: editArgs.edits.map(edit => ({
                old_string: edit.oldString,
                new_string: edit.newString
              })),
              state: "loading"
            };
            console.info(
              "[ai-edit] 待审查文件改动：",
              editCall.path,
              "替换块",
              editCall.edits.length
            );
            setEntries(list => [
              ...list,
              { kind: "edit", call: editCall }
            ]);
            pendingRef.current.set(toolCallId, {
              kind: "edit",
              call: editCall,
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
            shouldAutoRun(card, {
              autoExecute,
              autoApply,
              blacklist
            })
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
          // 记住是谁把循环挂起的。唤醒后**只在 pendingCardId 仍指着
          // 它时才清**：approvePlan 接手计划后会把 pendingCardId 改指
          // 成计划里的某一步（同步set 完才 await），而本续跑是微任务、
          // 排在那之后 —— 无条件清会把那个标记擦掉，症状是步骤一直
          // 「待执行」、执行按钮根本不渲染（2026-10-17 用户报）。
          // confirm / stop 的路径不受影响：那两条里 pendingCardId
          // 未被改指，条件成立照旧清。
          const yieldedCallId =
            calls[yieldedIndex]?.id;
          // 本批剩余的命令**排队**而不是丢弃：确认完当前卡片后按顺序
          // 执行（见 drainQueuedCommands）。只有 run_command 能排队 ——
          // 计划 / 反问 / 文件改动 / 文件传输一次只处理一个，成批出现
          // 时仍按旧逻辑回填占位（协议完整性要求每条 tool_call 都有
          // 配对的 tool 消息，否则下一轮供应商直接 400）
          queuedToolCallsRef.current = [];
          for (const call of calls.slice(
            yieldedIndex + 1
          )) {
            const rest =
              call.function.name ===
              TOOL_RUN_COMMAND
                ? parseToolArguments(
                    call.function.arguments
                  )
                : null;
            if (!rest) {
              messagesRef.current.push({
                role: "tool",
                content:
                  "[上一条命令等待用户确认，本条未执行；确认后请重新发起]",
                tool_call_id: call.id
              });
              continue;
            }
            queuedToolCallsRef.current.push({
              call: {
                id: call.id,
                command: rest.command,
                question: rest.question,
                isReadOnly: rest.isReadOnly,
                state: "pending"
              },
              toolCallId: call.id
            });
            console.info(
              "[ai-exec] 排队等待执行：",
              rest.command
            );
          }
          // 挂起：等确认 / 跳过后由 confirm / skip 里新一轮
          // runLoop 接管剩余循环，这里直接收尾。
          // 关键：runLoop 挂起时 send 的 await 还没返回，busy 仍是 true，
          // 不释放的话执行 / 后台执行 / 跳过按钮会一直处于禁用状态
          setBusy(false);
          await new Promise<void>(resolve => {
            resumeRef.current = resolve;
          });
          // 条件清（理由见上面的 yieldedCallId 注释）
          setPendingCardId(current =>
            current === yieldedCallId
              ? null
              : current
          );
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
      // @ 令牌 → 终端引用。正文剥掉令牌发给模型（可见 entry 仍保留
      // 带令牌的原文）；快照在**发送瞬间**从终端实时读，不随消息缓存
      const { text: asked, refs } =
        extractTerminalRefs(trimmed);
      const refBlocks = refs.map(ref =>
        formatTerminalRefBlock(
          ref.kind,
          readTerminalLines(
            session.terminal,
            ref.kind
          )
        )
      );
      if (refs.length > 0) {
        console.info(
          `[ai] 引用终端内容：${refs
            .map(ref => ref.kind)
            .join("、")}`
        );
      }
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
        content: `${asked}\n\n${workspaceContext(session)}${
          refBlocks.length > 0
            ? `\n\n${refBlocks.join("\n\n")}`
            : ""
        }`,
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
    // 计划执行中：没有 HTTP 流可掐（步骤走 exec 通道或在等单步确认），
    // 要停的是计划本身 —— 置中止标记，当前步骤落听后循环自然收摊
    if (planRunningRef.current) {
      planAbortRef.current = true;
      stoppedRef.current = true;
      // 夺取令牌：approvePlan 的 finally 见到非当轮会跳过收尾，
      // busy 由这里负责置回（计划在跑时 busy 归它持有）
      roundRef.current += 1;
      setBusy(false);
      // 正在后台跑的那条命令：让后端置取消标志、关 exec 通道。
      // 少了它，前端停了界面，命令还在服务器上跑（2026-10-17 用户报
      // 「点击了暂停，命令还在执行中」）
      const execId = runningExecIdRef.current;
      if (execId) {
        runningExecIdRef.current = null;
        console.info(
          "[ai] 停止：取消后台命令",
          execId
        );
        void cancelAiExec(execId);
      }
      const heldId = pendingCardId;
      setPendingCardId(null);
      // 在跑的步骤（自动执行路径没有挂起卡片）立刻标成已停止：
      // 后端取消也要一点时间，这期间界面必须先反映用户意图
      const running = planCurrentStepRef.current;
      if (running) {
        running.state = "skipped";
        running.error = "用户停止了计划";
        planCurrentStepRef.current = null;
      }
      if (heldId) {
        const stepHeld =
          pendingRef.current.get(heldId);
        if (
          stepHeld?.kind === "tool" &&
          stepHeld.planStep
        ) {
          pendingRef.current.delete(heldId);
          // 等确认中的步骤同样当场标停
          if (stepHeld.step) {
            stepHeld.step.state = "skipped";
            stepHeld.step.error =
              "用户停止了计划";
          }
          void executeCard(
            stepHeld.call,
            stepHeld.toolCallId,
            "background",
            true
          ).then(() => {
            stepHeld.call.error =
              "用户停止了计划";
            setEntries(list => [...list]);
            stepHeld.settle?.(true);
          });
        }
      }
      setEntries(list => [...list]);
      console.info("[ai] 停止：中止计划执行");
      return;
    }
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
        // 等批准的计划：没有循环在跑（busy 是 false），作废挂起、
        // 标记取消、回填 tool 结果后放走 runLoop 即可，不执行任何步骤
        if (held.kind === "plan") {
          roundRef.current += 1;
          stoppedRef.current = true;
          pendingRef.current.delete(
            pendingCardId
          );
          held.call.state = "cancelled";
          setEntries(list => [...list]);
          messagesRef.current.push({
            role: "tool",
            tool_call_id: held.call.id,
            content:
              "[用户停止了本轮，该计划未执行]"
          });
          resumeRef.current?.();
          console.info(
            `[ai] 停止：放弃待批准计划 ${pendingCardId}`
          );
          setPendingCardId(null);
          return;
        }
        // 等作答的反问：同理，作废挂起 + 标记跳过 + 回填后放走
        if (held.kind === "question") {
          roundRef.current += 1;
          stoppedRef.current = true;
          pendingRef.current.delete(
            pendingCardId
          );
          held.call.state = "cancelled";
          setEntries(list => [...list]);
          messagesRef.current.push({
            role: "tool",
            tool_call_id: held.call.id,
            content:
              "[用户停止了本轮，提问未回答]"
          });
          resumeRef.current?.();
          console.info(
            `[ai] 停止：放弃待回答提问 ${pendingCardId}`
          );
          setPendingCardId(null);
          return;
        }
        // 待批准的文件改动：作废挂起 + 标记取消 + 回填后放走，
        // 文件不被改动。⚠️ 若改动正在写回中（applying），走的是上面的
        // 流式分支：busy 为真、pendingCardId 为空 —— 那时的停止**不
        // 取消写回**，`cat >` 先截断再写，掐断只会留下半个文件，比
        // 让它写完更坏；写完卡片照常翻「已应用」。
        if (held.kind === "edit") {
          roundRef.current += 1;
          stoppedRef.current = true;
          pendingRef.current.delete(
            pendingCardId
          );
          held.call.state = "cancelled";
          setEntries(list => [...list]);
          messagesRef.current.push({
            role: "tool",
            tool_call_id: held.call.id,
            content:
              "[用户停止了本轮，文件未被改动]"
          });
          resumeRef.current?.();
          console.info(
            `[ai] 停止：放弃待批准文件改动 ${pendingCardId}`
          );
          setPendingCardId(null);
          return;
        }
        pendingRef.current.delete(pendingCardId);
        // 同批排队的命令一并作废：停止就是全停，别把后面的留着
        // （留着的话下次 confirm 会把它们跑掉，用户没批准过）
        for (const queued of queuedToolCallsRef.current) {
          messagesRef.current.push({
            role: "tool",
            content:
              "[用户停止了本轮，本条未执行]",
            tool_call_id: queued.toolCallId
          });
        }
        queuedToolCallsRef.current = [];
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
    // 工具循环可能正卡在后台命令上（自动执行的命令卡）：没有流可掐，
    // 但要取消那条命令 —— 否则前端停了，服务器上还在跑
    const execId = runningExecIdRef.current;
    if (execId) {
      runningExecIdRef.current = null;
      console.info(
        "[ai] 停止：取消后台命令",
        execId
      );
      void cancelAiExec(execId);
    }
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
      if (!held) return;
      // 计划卡 / 反问卡 / 文件改动卡不走 confirm：批准 / 取消 / 作答 /
      // 应用都有专属入口，这里挡掉误调并收窄联合类型
      if (
        held.kind === "plan" ||
        held.kind === "question" ||
        held.kind === "edit"
      )
        return;
      // 计划里的单步：执行后只唤醒计划循环（approvePlan 正等在 settle
      // 上），不认领轮次、不碰 busy、不另起 runLoop —— 计划还没跑完，
      // 收尾归 approvePlan 统一做。少了这个分支，下面的 setBusy(false)
      // 会让计划执行到一半底部发送键就恢复可点，新消息趁虚而入。
      // ⚠️ 必须在 option 守卫**之前**：步骤执行走 exec 通道，不需要
      // 模型选项；selected 为 null（存的模型 id 对不上任何供应商）时
      // 被守卫挡掉，settle 永远不来 —— 症状就是步骤一直「执行中」。
      if (held.kind === "tool" && held.planStep) {
        if (option) optionRef.current = option;
        beginRound();
        pendingRef.current.delete(cardId);
        // 先置 running 再执行：后台命令最长要跑 60s，这期间步骤行
        // 得显示「执行中…」而不是「等待确认」—— 否则用户以为点了
        // 没反应（2026-10-17 用户报「无法执行步骤」的观感之一）
        if (held.step) {
          held.step.state = "running";
          setEntries(list => [...list]);
        }
        await executeCard(
          held.call,
          held.toolCallId,
          mode
        );
        held.settle?.(false);
        return;
      }
      if (!option) return;
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
      // 同一批里还有排队的命令：先把它们跑完再回到模型 —— 否则模型
      // 拿不到这些命令的结果，只能让用户重新放行（旧行为，用户报过）
      if (await drainQueuedCommands()) {
        // 已经弹出下一张确认卡：释放 busy 让它的按钮可点，
        // 本轮由那张卡的 confirm 接管
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        }
        return;
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
      drainQueuedCommands,
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
      if (!held) return;
      // 同 confirm：计划卡 / 反问卡 / 文件改动卡不走 skip
      if (
        held.kind === "plan" ||
        held.kind === "question" ||
        held.kind === "edit"
      )
        return;
      // 计划里的单步：同 confirm 的 planStep 分支 —— 只唤醒计划循环，
      // 跳过的步骤由计划循环标记后继续下一步。⚠️ 同样要在 option
      // 守卫之前（跳过一步不需要模型），否则 selected 为 null 时
      // 点「跳过」没反应，计划卡死在这步
      if (held.kind === "tool" && held.planStep) {
        if (option) optionRef.current = option;
        beginRound();
        pendingRef.current.delete(cardId);
        await executeCard(
          held.call,
          held.toolCallId,
          "background",
          true
        );
        held.settle?.(true);
        return;
      }
      if (!option) return;
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
      // 同 confirm：同批排队的命令先跑完（跳过当前这张，不代表跳过后面）
      if (await drainQueuedCommands()) {
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        }
        return;
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
      drainQueuedCommands,
      runLoop,
      beginRound
    ]
  );

  /**
   * 批准执行一个多步计划。
   *
   * 与 confirm 的关键差别：confirm 收尾后自己续跑 runLoop，而计划的每一步
   * 可能还要单独等用户确认（读写步骤未开「自动应用」、或命中黑名单时），
   * 所以收尾必须留在计划全部跑完之后统一做 —— 否则中间某步 confirm 的
   * `setBusy(false)` 会把 busy 冲掉，计划执行到一半底部发送键就恢复可点。
   *
   * 协议流两手准备：
   * ① 立刻回填计划自己的 tool 结果（批准即答复，模型不用干等）；
   * ② 把步骤落成一条 assistant `tool_calls` 消息（每步一条 run_command，
   *   id 与步骤卡片一致）—— 否则 executeCard 回填的单步 tool 消息是
   *   孤儿，会被 repairToolMessages 丢掉，模型看不到单步结果。
   */
  const approvePlan = useCallback(
    async (
      callId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(callId);
      if (!held || held.kind !== "plan") return;
      // ⚠️ 不因 option 为 null 就 return：步骤走 exec 通道，不需要
      // 模型；selected 为 null（存的模型 id 对不上任何供应商）时静默
      // return 会让用户点了「开始执行」毫无反应。没有模型只是跑完
      // 没人总结，执行本身照常
      if (option) optionRef.current = option;
      // 用户主动批准 = 想让这轮继续，清掉停止标记
      beginRound();
      // 认领本轮：被唤醒的旧 runLoop 会立刻 return 并跑它自己的
      // finally，没有令牌的话那里的 setBusy(false) 会把下面冲掉
      const round = (roundRef.current += 1);
      setBusy(true);
      pendingRef.current.delete(callId);
      // 放走挂起的 runLoop（同 confirm 的 resumeRef 用法）
      resumeRef.current?.();
      planAbortRef.current = false;
      planRunningRef.current = true;
      const plan = held.call;
      plan.state = "running";
      setEntries(list => [...list]);
      try {
        messagesRef.current.push({
          role: "tool",
          tool_call_id: plan.id,
          content:
            "[用户已批准该计划，开始按步骤执行]"
        });
        messagesRef.current.push({
          role: "assistant",
          content: null,
          tool_calls: plan.steps.map(step => ({
            id: step.id,
            type: "function" as const,
            function: {
              name: TOOL_RUN_COMMAND,
              arguments: JSON.stringify({
                command: step.command,
                question: step.title,
                is_read_only: step.isReadOnly
              })
            }
          }))
        });
        const {
          autoExecute,
          autoApply,
          blacklist
        } = runOptionsRef.current;
        for (
          let index = 0;
          index < plan.steps.length;
          index += 1
        ) {
          const step = plan.steps[index];
          // 下标访问在 strict 下可能 undefined：越界即止（防御，
          // 正常流程走不到）
          if (!step) break;
          if (planAbortRef.current) break;
          // 记下当前步骤：停止时（自动执行中没有挂起卡片）靠它把
          // 这一行立刻标成已停止
          planCurrentStepRef.current = step;
          // 临时包成 AiToolCall 走既有执行通道（cardExec 管状态、
          // 输出截断与协议回填），计划卡自己渲染步骤，不另发条目
          const card: AiToolCall = {
            id: step.id,
            command: step.command,
            question: step.title,
            isReadOnly: step.isReadOnly,
            state: "pending"
          };
          console.info(
            "[ai-plan] 执行步骤",
            index + 1,
            step.command,
            "isReadOnly:",
            step.isReadOnly
          );
          let skipped = false;
          if (
            planStepAutoRuns(step, {
              autoExecute,
              autoApply,
              blacklist
            })
          ) {
            // 只有**真的开始跑**才置 running —— 等确认期间保持
            // pending（卡片显示「等待确认」）。提前置 running 会让
            // 用户以为已在执行，干等着不动（2026-10-17 用户报
            // 「一直显示执行中」）。
            step.state = "running";
            setEntries(list => [...list]);
            await executeCard(card, step.id);
          } else {
            // 未开自动执行 / 应用（或命中黑名单）：这一步单独等确认，
            // 复用 pendingRef + settle —— confirm / skip 的 planStep
            // 分支执行完只唤醒这里，不碰 busy 与 runLoop
            let settleStep: (
              skipped: boolean
            ) => void = () => {};
            const settled = new Promise<boolean>(
              resolve => {
                settleStep = resolve;
              }
            );
            pendingRef.current.set(step.id, {
              kind: "tool",
              call: card,
              toolCallId: step.id,
              planStep: true,
              step,
              settle: settleStep
            });
            setPendingCardId(step.id);
            skipped = await settled;
          }
          // 摘掉这一步的挂起标记：不清的话 pendingCardId 一直指着
          // 已完成的步骤 —— 发送键永远禁用，步骤行还挂着「执行 / 跳过」
          setPendingCardId(current =>
            current === step.id ? null : current
          );
          if (planAbortRef.current) {
            // 已停止：step 状态被 stop 当场标好了（skipped + 原因），
            // 不用迟到的执行结果覆盖 —— 后端命令取消也要一点时间，
            // 其结果与「用户已停止」无关
            planCurrentStepRef.current = null;
            setEntries(list => [...list]);
            break;
          }
          planCurrentStepRef.current = null;
          // 卡片执行结果搬回步骤（供计划卡渲染）
          step.state = skipped
            ? "skipped"
            : card.state === "done"
              ? "done"
              : "failed";
          step.exitCode = card.exitCode;
          step.error = card.error;
          step.stdout = card.stdout;
          step.stderr = card.stderr;
          setEntries(list => [...list]);
        }
        const aborted = planAbortRef.current;
        plan.state = aborted ? "aborted" : "done";
        setEntries(list => [...list]);
        console.info(
          "[ai-plan] 计划结束：",
          plan.title,
          plan.state
        );
        // 中止（用户点了停止）不续跑：stoppedRef 会挡住工具循环，
        // 剩下的步骤由 repairToolMessages 补占位。
        // 没有可用模型时同样不续跑（executeCard 已把结果写进协议流，
        // 下次有模型的会话接着问即可）
        if (!aborted && option)
          await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        planRunningRef.current = false;
        planCurrentStepRef.current = null;
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai-plan] 收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [executeCard, runLoop, beginRound]
  );

  /**
   * 取消一个待批准的计划：回填 tool 结果后让模型回应用户。
   *
   * 不执行任何命令；模型收到取消反馈后会询问原因或给出调整后的方案。
   */
  const rejectPlan = useCallback(
    async (
      callId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(callId);
      if (!held || held.kind !== "plan") return;
      // 同 approvePlan：没有模型也允许取消（标记 + 回填即可，
      // 问「为什么取消」留给下次有模型的会话）
      if (option) optionRef.current = option;
      beginRound();
      const round = (roundRef.current += 1);
      setBusy(true);
      pendingRef.current.delete(callId);
      resumeRef.current?.();
      held.call.state = "cancelled";
      setEntries(list => [...list]);
      messagesRef.current.push({
        role: "tool",
        tool_call_id: held.call.id,
        content:
          "[用户取消了该计划，未执行任何命令。请询问原因，或给出调整后的方案]"
      });
      console.info(
        "[ai-plan] 用户取消计划：",
        held.call.title
      );
      try {
        if (option) await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai-plan] 取消收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [runLoop, beginRound]
  );

  /**
   * 提交一组反问的作答：答案回填成 tool 结果，模型据此继续。
   *
   * 与 confirm 的差别同 approvePlan：收尾（续跑 runLoop）由本函数统一
   * 做，不借道 confirm —— 那张卡没有「执行 / 跳过」语义。
   */
  const answerQuestions = useCallback(
    async (
      callId: string,
      option: AiModelOption | null,
      answers: Record<string, string>
    ) => {
      const held = pendingRef.current.get(callId);
      if (!held || held.kind !== "question")
        return;
      if (option) optionRef.current = option;
      beginRound();
      const round = (roundRef.current += 1);
      setBusy(true);
      pendingRef.current.delete(callId);
      // 放走挂起的 runLoop（同 approvePlan 的 resumeRef 用法）
      resumeRef.current?.();
      const call = held.call;
      call.answers = { ...answers };
      call.state = "answered";
      setEntries(list => [...list]);
      // 答案格式化成模型可读的文本：题号 + 问题 + 作答
      const lines = call.questions.map(
        (question, index) =>
          `${index + 1}. ${question.prompt}\n答：${
            answers[question.id]?.trim() ||
            "（未答）"
          }`
      );
      messagesRef.current.push({
        role: "tool",
        tool_call_id: call.id,
        content: `[用户的回答]\n${lines.join("\n")}`
      });
      console.info(
        "[ai-ask] 用户已作答：",
        call.title
      );
      try {
        if (option) await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai-ask] 收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [runLoop, beginRound]
  );

  /**
   * 跳过一组反问：回填 tool 结果让模型按默认方案继续。
   *
   * 不执行任何命令；提示词已要求模型在这种情况下说明自己的假设。
   */
  const cancelQuestions = useCallback(
    async (
      callId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(callId);
      if (!held || held.kind !== "question")
        return;
      if (option) optionRef.current = option;
      beginRound();
      const round = (roundRef.current += 1);
      setBusy(true);
      pendingRef.current.delete(callId);
      resumeRef.current?.();
      held.call.state = "cancelled";
      setEntries(list => [...list]);
      messagesRef.current.push({
        role: "tool",
        tool_call_id: held.call.id,
        content:
          "[用户跳过了提问，未作回答。请按最安全的默认方案处理，并在回复里说明你的假设]"
      });
      console.info(
        "[ai-ask] 用户跳过提问：",
        held.call.title
      );
      try {
        if (option) await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai-ask] 跳过收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [runLoop, beginRound]
  );

  /**
   * 加载一张文件改动卡的 diff：读服务端真实文件 → 本地应用替换块 →
   * 算 diff。卡片挂载时经 onLoad 触发；幂等（只在 loading 态干活）。
   *
   * ⚠️ diff 一定基于**服务端刚读到的内容**算，不信模型上下文里的旧
   * 版本：匹配不上就报错让人重来，不静默写坏文件。
   */
  const loadFileEdit = useCallback(
    async (callId: string) => {
      const held = pendingRef.current.get(callId);
      if (!held || held.kind !== "edit") return;
      const call = held.call;
      if (call.state !== "loading") return;
      try {
        const content = await readRemoteFileText(
          session,
          call.path
        );
        // 二进制（含 NUL）不碰：diff 没有意义，写回更是灾难
        if (content.includes("\0"))
          throw new Error(
            "二进制文件，无法生成 diff 预览"
          );
        if (content.length > FILE_DIFF_LIMIT)
          throw new Error(
            `文件过大（${content.length} 字符，上限 ${FILE_DIFF_LIMIT}），无法生成 diff 预览，请缩小改动范围或自行编辑`
          );
        const applied = applyEdits(
          content,
          call.edits.map(edit => ({
            oldString: edit.old_string,
            newString: edit.new_string
          }))
        );
        if (!applied.ok)
          throw new Error(applied.reason);
        const diff = computeLineDiff(
          content,
          applied.newContent
        );
        call.oldContent = content;
        call.newContent = applied.newContent;
        call.hunks = buildHunks(diff.lines);
        call.addedLines = diff.added;
        call.removedLines = diff.removed;
        call.state = "ready";
      } catch (reason) {
        call.state = "error";
        call.error = String(reason);
      }
      setEntries(list => [...list]);
    },
    [session]
  );

  /**
   * 批准一次文件改动：把算好的新内容写回服务器，然后续一轮模型总结。
   *
   * 写回走 exec 通道的 stdin 数据流（fileEditExec），与读文件串行在
   * 同一把会话锁上，不会出现半成品。
   */
  const approveFileEdit = useCallback(
    async (
      callId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(callId);
      if (
        !held ||
        held.kind !== "edit" ||
        // 只在 diff 就绪时可批准；error / 已应用的一律不接
        held.call.state !== "ready"
      )
        return;
      if (option) optionRef.current = option;
      beginRound();
      const round = (roundRef.current += 1);
      setBusy(true);
      pendingRef.current.delete(callId);
      resumeRef.current?.();
      const call = held.call;
      call.state = "applying";
      setEntries(list => [...list]);
      try {
        await writeRemoteFileText(
          session,
          call.path,
          call.newContent ?? ""
        );
        call.state = "applied";
        messagesRef.current.push({
          role: "tool",
          tool_call_id: call.id,
          content: `[文件已按批准的 diff 修改：${call.path}（+${call.addedLines ?? 0} -${call.removedLines ?? 0} 行）]`
        });
        console.info(
          "[ai-edit] 文件已写回：",
          call.path
        );
      } catch (reason) {
        call.state = "error";
        call.error = String(reason);
        // 写失败也要回填 tool 结果，否则协议流断裂
        messagesRef.current.push({
          role: "tool",
          tool_call_id: call.id,
          content: `[写入失败，文件未被改动：${String(reason)}]`
        });
      }
      setEntries(list => [...list]);
      try {
        if (option) await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai-edit] 收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [session, runLoop, beginRound]
  );

  /**
   * 取消一次文件改动：文件不被改动，回填 tool 结果让模型回应用户。
   */
  const cancelFileEdit = useCallback(
    async (
      callId: string,
      option: AiModelOption | null
    ) => {
      const held = pendingRef.current.get(callId);
      if (!held || held.kind !== "edit") return;
      if (option) optionRef.current = option;
      beginRound();
      const round = (roundRef.current += 1);
      setBusy(true);
      pendingRef.current.delete(callId);
      resumeRef.current?.();
      held.call.state = "cancelled";
      setEntries(list => [...list]);
      messagesRef.current.push({
        role: "tool",
        tool_call_id: held.call.id,
        content:
          "[用户取消了该文件修改，文件未被改动。可以询问原因或给出调整后的方案]"
      });
      console.info(
        "[ai-edit] 用户取消文件改动：",
        held.call.path
      );
      try {
        if (option) await runLoop(option);
      } catch (reason) {
        setError(String(reason));
      } finally {
        if (ownsRound(round, roundRef.current)) {
          setBusy(false);
          setStream(null);
          streamIdRef.current = null;
        } else {
          console.info(
            `[ai-edit] 取消收尾跳过（第 ${round} 轮已被第 ${roundRef.current} 轮接管）`
          );
        }
      }
    },
    [runLoop, beginRound]
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
    /** 批准执行一个多步计划（逐步执行，跑完续一轮模型总结） */
    approvePlan,
    /** 取消一个待批准的计划（不执行任何命令） */
    rejectPlan,
    /** 提交一组反问的作答（答案回填后模型继续） */
    answerQuestions,
    /** 跳过一组反问（模型按默认方案继续） */
    cancelQuestions,
    /** 加载文件改动卡的 diff（读真实文件 + 本地应用 + 算 diff） */
    loadFileEdit,
    /** 批准一次文件改动（写回服务器后续一轮总结） */
    approveFileEdit,
    /** 取消一次文件改动（文件不被改动） */
    cancelFileEdit,
    clear: history.clear,
    restore: history.restore,
    renameCurrent: history.renameCurrent,
    updateQueued: queue.enqueue,
    removeQueued: queue.dequeue,
    reorderQueued: queue.reorder,
    nudgeQueuedBy: queue.nudgeBy
  };
}
