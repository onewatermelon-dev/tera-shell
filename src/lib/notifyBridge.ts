/**
 * 通知的跨层桥接。
 *
 * ## 为什么需要它
 *
 * AI 回答完成的触发点在 `aiChat.ts`（数据层），而开关与窗口焦点判定
 * 在 App 层的 `useNotifications`。中间隔着 AiPanel、TerminalWorkspace
 * 两层纯 UI 组件 —— 为一个通知回调把 props 一路透传下去，会让这两个
 * 组件凭空多出一个与自身职责无关的参数，且以后每加一层 UI 都要记得
 * 再传一次。
 *
 * 这里用一个模块级单例做注册/触发：App 启动时注册一个函数，
 * `aiChat` 在事件发生处直接 emit。与 `PROVIDERS_CHANGED_EVENT`
 * （window 事件）同源的做法，但省掉字符串事件名与 `CustomEvent` 包装。
 *
 * ## 单例的代价与对策
 *
 * 代价是「谁在调用 emit」这件事在代码里看不见。对策是把 emit 收在这
 * 一个模块里、命名写清楚（`emitAiDone`），并在注册处注释说明调用方。
 * 反正 AI 对话链路是全局唯一的（一个应用一个 AI 面板体系），不存在
 * 「多份 handler 该给谁」的歧义。
 */

/** AI 回答完成的回调签名。 */
export type AiDoneHandler = (
  modelLabel: string,
  elapsedMs: number,
  preview: string
) => void;

/** 当前注册的处理器；`null` 表示没人监听（通知功能未接线）。 */
let aiDoneHandler: AiDoneHandler | null = null;

/** 注册处理器（App 挂载时调用）；返回反注册函数供卸载时清理。 */
export function registerAiDoneHandler(
  handler: AiDoneHandler | null
): () => void {
  aiDoneHandler = handler;
  return () => {
    // 只清自己注册的那个：若期间别人重新注册过，别把人家的抹掉
    if (aiDoneHandler === handler)
      aiDoneHandler = null;
  };
}

/**
 * 广播「AI 回答完成」。调用方：`aiChat.ts` 的流式请求正常收尾处。
 *
 * 没有 handler 时静默返回 —— 通知是可选功能，不该因为没人监听而出错。
 */
export function emitAiDone(
  modelLabel: string,
  elapsedMs: number,
  preview: string
): void {
  try {
    aiDoneHandler?.(
      modelLabel,
      elapsedMs,
      preview
    );
  } catch (reason) {
    // 通知失败绝不能影响 AI 回复本身的产出
    console.warn(
      "[notify] AI 完成回调抛错，已忽略",
      reason
    );
  }
}
