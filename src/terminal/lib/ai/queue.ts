/**
 * AI 消息队列：AI 在跑（busy）或正等工具确认（pendingCardId）时，用户
 * 再发的消息不丢弃，排进这里等本轮结束自动续发。
 *
 * 从 aiChat.ts 拆出。全部是纯函数 + 类型，供 useAiChat 与 UI 直接使用。
 */

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
