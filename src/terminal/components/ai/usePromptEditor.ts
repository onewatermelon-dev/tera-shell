"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { stepPromptHistory } from "./promptInputUtils";

/**
 * contentEditable 编辑器：草稿状态、已发送历史召回（↑/↓）、Enter 发送。
 *
 * 历史召回命中后光标落到行尾；越过最新一条时恢复未发送草稿
 * （`stepPromptHistory` 是纯函数，单独放在 promptInputUtils 供测试）。
 * 发送时清空编辑器并把焦点还回去，`onSubmit` 只拿纯文本。
 */
export function usePromptEditor({
  history,
  images,
  onSubmit
}: {
  /** 当前对话中已发送的文字问题，按发送顺序排列。 */
  history: string[];
  /** 待发送的图片；只发图不发消息也允许发送 */
  images: string[];
  /** 用户按下发送（Enter 或点击箭头），参数为编辑器纯文本 */
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);
  const historyIndexRef = useRef<number | null>(
    null
  );
  const draftRef = useRef("");
  const previousHistoryRef = useRef(history);

  useEffect(() => {
    const previous = previousHistoryRef.current;
    if (
      previous.length !== history.length ||
      previous.some(
        (text, index) => text !== history[index]
      )
    ) {
      historyIndexRef.current = null;
      draftRef.current = "";
    }
    previousHistoryRef.current = history;
  }, [history]);

  const hasText = value.trim().length > 0;
  // 只发图不发消息也允许发送
  const canSend = hasText || images.length > 0;

  const syncFromEditor = () => {
    setValue(
      editorRef.current?.textContent ?? ""
    );
  };

  const onEditorKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    if (
      (event.key === "ArrowUp" ||
        event.key === "ArrowDown") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      history.length > 0
    ) {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (
        !editor ||
        !selection?.isCollapsed ||
        !selection.anchorNode
      )
        return;
      const current = historyIndexRef.current;
      if (
        event.key === "ArrowDown" &&
        current === null
      )
        return;
      if (
        event.key === "ArrowUp" &&
        current === null &&
        (value.includes("\n") ||
          editor.querySelector("br, div"))
      ) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.setEnd(
          selection.anchorNode,
          selection.anchorOffset
        );
        if (!range.collapsed) return;
      }
      event.preventDefault();
      if (current === null)
        draftRef.current = value;
      const recalled = stepPromptHistory(
        history,
        current,
        draftRef.current,
        event.key === "ArrowUp" ? "up" : "down"
      );
      historyIndexRef.current = recalled.index;
      const nextValue = recalled.value;
      editor.textContent = nextValue;
      setValue(nextValue);
      const caret = document.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(false);
      selection.removeAllRanges();
      selection.addRange(caret);
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      // Shift+Enter 换行；Enter 直接发送
      event.preventDefault();
      send();
    }
  };

  const send = () => {
    if (!canSend) return;
    const text = value;
    historyIndexRef.current = null;
    draftRef.current = "";
    if (editorRef.current) {
      editorRef.current.innerHTML = "";
    }
    setValue("");
    requestAnimationFrame(() =>
      editorRef.current?.focus()
    );
    onSubmit(text);
  };

  return {
    value,
    hasText,
    canSend,
    editorRef,
    syncFromEditor,
    onEditorKeyDown,
    send
  };
}
