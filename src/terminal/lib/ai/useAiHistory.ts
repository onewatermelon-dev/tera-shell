import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import {
  saveHistory,
  type AiHistory
} from "./aiHistory";
import type { OpenSession } from "../session/terminalTypes";
import type {
  AiChatEntry,
  AiPlanCall,
  ProtocolMessage
} from "./protocol";

/**
 * 恢复历史时把计划卡归一成终态。
 *
 * 落盘时的计划可能还是 pending / running（应用在执行中被关掉），恢复后
 * 没有任何循环驱动它，原样渲染就是一张永远「等待批准」或永远转圈的死卡。
 * 统一改成「已中止」，未结束的步骤标「已跳过」—— 与用户主动停止计划
 * 的呈现一致。已是终态（done / cancelled / aborted）的原样返回。
 */
export function normalizeRestoredPlan(
  call: AiPlanCall
): AiPlanCall {
  if (
    call.state !== "pending" &&
    call.state !== "running"
  )
    return call;
  return {
    ...call,
    state: "aborted",
    steps: call.steps.map(step =>
      step.state === "done" ||
      step.state === "failed"
        ? step
        : {
            ...step,
            state: "skipped" as const,
            error:
              step.error ?? "会话中断，未执行"
          }
    )
  };
}

/**
 * AI 对话的历史持久化与标题。
 *
 * 从 useAiChat 搬出：落盘 / 恢复 / 改名 / 清空是独立关注点，
 * 与工具循环（runLoop）无耦合。「在跑的那轮」的重置由门面以
 * `resetLiveState` 注入 —— 那里持有 roundRef / pendingCardId 等
 * 循环状态；挂起的卡片与循环句柄同理走 `releasePending`。
 *
 * ⚠️ 恢复**不**清 pendingRef / resumeRef（与原实现一致）：挂起的
 * 卡片按 toolCallId 存放，切历史后成为无害的孤儿条目。
 */
export function useAiHistory(options: {
  session: OpenSession | undefined;
  entries: AiChatEntry[];
  busy: boolean;
  /** 协议消息流（含 system / tool 等内部消息） */
  messagesRef: RefObject<ProtocolMessage[]>;
  setEntries: Dispatch<
    SetStateAction<AiChatEntry[]>
  >;
  /** 恢复/清空前重置「在跑的那轮」：待确认卡片、错误、流、轮次令牌、队列 */
  resetLiveState: () => void;
  /** 清空还要释放挂起的卡片与循环句柄 */
  releasePending: () => void;
}) {
  const {
    session,
    entries,
    busy,
    messagesRef,
    setEntries,
    resetLiveState,
    releasePending
  } = options;

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
  }, [busy, entries, session, messagesRef]);

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
            // 卡片条目（命令 / 文件传输）没有 sentAt，
            // 别给它硬塞一个 —— 它们的 key 用的是 call.id
            entry.kind === "user" ||
            entry.kind === "assistant"
              ? {
                  ...entry,
                  sentAt:
                    entry.sentAt ??
                    history.updatedAt
                }
              : entry.kind === "plan"
                ? // 计划卡恢复时可能停在「待批准 / 执行中」——
                  // 那是上一段会话的活，恢复后没有循环驱动它，
                  // 不归一化就是一张永远转圈或按钮永灰的死卡
                  {
                    kind: "plan",
                    call: normalizeRestoredPlan(
                      entry.call
                    )
                  }
                : entry
        )
      );
      // 作废在跑的那轮：切历史后旧循环不该再往新话题里写东西，
      // 它的 finally 也不该再去改busy。
      // 切历史等于换了一个话题，上一轮的排队消息不该跟过来。
      resetLiveState();
    },
    [messagesRef, setEntries, resetLiveState]
  );

  const clear = useCallback(() => {
    messagesRef.current = [];
    releasePending();
    setEntries([]);
    // 同 restore：新对话要作废在跑的那轮；
    // 旧问题的排队尾巴同理不带进新会话
    resetLiveState();
    // 清空后下一次保存开一条新历史，不覆盖旧的
    historyIdRef.current = null;
    historyTitleRef.current = null;
    setTitle(null);
  }, [
    messagesRef,
    setEntries,
    resetLiveState,
    releasePending
  ]);

  return {
    title,
    renameCurrent,
    restore,
    clear
  };
}
