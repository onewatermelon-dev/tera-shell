import {
  useCallback,
  useSyncExternalStore
} from "react";
import type { Terminal } from "@xterm/xterm";

/**
 * 订阅活动终端的选区变化，供标题栏菜单「复制」等判可用性。
 *
 * xterm 只发选区事件、没有可轮询的状态，用 useSyncExternalStore 订阅
 * 活动终端（订阅外部系统的标准做法，也避免在 effect 里同步 setState
 * 造成的级联渲染）。
 *
 * ⚠️ subscribe / getSnapshot 必须用 useCallback 稳住引用：订阅函数
 * 每次渲染都换新人的话，useSyncExternalStore 会每渲染重订阅一遍。
 * 依赖只有 activeTerminal —— 终端实例换一只（切会话 / 拆分窗格）时才
 * 该重订阅。
 */
export function useTerminalSelection(
  activeTerminal: Terminal | undefined
): boolean {
  const subscribeSelection = useCallback(
    (onChange: () => void) => {
      if (!activeTerminal) return () => {};
      const disposable =
        activeTerminal.onSelectionChange(
          onChange
        );
      return () => disposable.dispose();
    },
    [activeTerminal]
  );
  const readSelection = useCallback(
    () =>
      Boolean(
        activeTerminal?.hasSelection() &&
        activeTerminal.getSelection().trim()
      ),
    [activeTerminal]
  );
  return useSyncExternalStore(
    subscribeSelection,
    readSelection
  );
}
