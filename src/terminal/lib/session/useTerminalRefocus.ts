/**
 * 焦点回还：窗口重新抢回系统焦点时，把键盘焦点交还给正对着的终端。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。只要用户没有明确在
 * 别处打字（AI 输入框 / 搜索框等文本控件），且设置页没开，就交还 ——
 * 光标常亮闪烁，不用每次先点一下。
 */
import { useCallback, useEffect } from "react";

export function useTerminalRefocus(
  /** 活动窗格正在显示的那只会话（快捷宏的执行目标同一只） */
  targetId: string | undefined,
  onFocusTerminal: (id: string) => void
) {
  const refocusTerminal = useCallback(() => {
    if (document.querySelector(".settings-page"))
      return;
    const el = document.activeElement;
    if (
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable)
    )
      return;
    if (targetId) onFocusTerminal(targetId);
  }, [targetId, onFocusTerminal]);

  useEffect(() => {
    window.addEventListener(
      "focus",
      refocusTerminal
    );
    return () =>
      window.removeEventListener(
        "focus",
        refocusTerminal
      );
  }, [refocusTerminal]);
}
