import { useCallback, useState } from "react";
import {
  dequeueMessage,
  enqueueMessage,
  moveQueued,
  nudgeQueued,
  type AiQueuedMessage
} from "./queue";

/**
 * AI 生成中的消息队列。
 *
 * 用 state 而非 ref：输入框上方要把队列画出来，ref 写它不触发渲染。
 * 出队时机在 confirm / skip / send 的 finally 里 —— 三条路径都可能让
 * busy 与 pendingCardId 同时归零（续发 effect 住在门面 useAiChat，
 * 那里才同时看得见 busy / pendingCardId / dispatch）。
 *
 * 本 hook **不认识** busy、会话与模型：只做队列本身的增删改序，
 * 纯函数（enqueue / dequeue / moveQueued / nudgeQueued）在 queue.ts。
 */
export function useAiQueue() {
  const [queued, setQueued] = useState<
    AiQueuedMessage[]
  >([]);

  /** 入队 / 编辑一条排队消息（同 id 覆盖，不新增条目；缺 id 自动生成）。 */
  const enqueue = useCallback(
    (
      message: Omit<AiQueuedMessage, "id"> & {
        id?: string;
      }
    ) => {
      setQueued(list =>
        enqueueMessage(list, message)
      );
    },
    []
  );

  /** 出队 / 丢弃一条排队消息。 */
  const dequeue = useCallback((id: string) => {
    setQueued(list => dequeueMessage(list, id));
  }, []);

  /**
   * 拖拽换序：把 id 这条挪到 targetId 的位置。
   *
   * 队列本来是严格 FIFO（见 useAiChat 的 send 与续发 effect），用户却
   * 希望能调整顺序 —— 比如连着问三件事时把最关心的排到最后立刻问。
   * 所以这里显式允许重排，续发 effect 取的仍是 queued[0]，重排后
   * 自然生效。
   */
  const reorder = useCallback(
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
  const nudgeBy = useCallback(
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

  /**
   * 清空队列：恢复历史 / 开新对话时调用 ——
   * 旧问题的排队尾巴不该带进新话题。
   */
  const clear = useCallback(() => {
    setQueued([]);
  }, []);

  return {
    queued,
    enqueue,
    dequeue,
    reorder,
    nudgeBy,
    clear
  };
}
