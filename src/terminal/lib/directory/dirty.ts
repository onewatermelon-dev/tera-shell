/**
 * 「目录可能变了」的轻量广播。
 *
 * 目录栏平时靠 OSC 7 跟随 `cd`，但 `rm` / `touch` 这类**不换目录**的
 * 文件操作不会触发上报。这里给可能改目录内容的动作（终端命令结束、
 * AI 命令与文件传输完成）一个统一的广播口子，目录栏自己监听后重读
 * 当前目录 —— 用 DOM 自定义事件而不是穿 props，省掉三层透传。
 */

/** 目录栏监听的事件名。 */
const EVENT = "tera-directory-dirty";

/** 广播一次「目录可能变了」（当前会话的目录栏收到后重读）。 */
export function notifyDirectoryDirty(): void {
  window.dispatchEvent(new Event(EVENT));
}

/**
 * 监听目录变化广播。
 *
 * @returns 取消监听的函数（effect cleanup 用）
 */
export function onDirectoryDirty(
  callback: () => void
): () => void {
  window.addEventListener(EVENT, callback);
  return () =>
    window.removeEventListener(EVENT, callback);
}
