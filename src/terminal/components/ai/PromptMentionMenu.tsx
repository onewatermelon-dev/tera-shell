"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/settings/lib/i18n";
import menuStyles from "./PromptInputMenu.module.css";
import { TERMINAL_REF_ITEMS } from "@/terminal/lib/ai/terminalRefs";

/**
 * 「@」引用菜单：输入框上方列出可引用的终端内容。
 *
 * 复用「+」菜单的容器与条目样式（同一个 CSS module，类名哈希一致），
 * 只多一个右对齐的令牌提示 —— 令牌同时告诉用户「也可以直接手打」。
 * 键盘：↑↓ 移动、Enter 选中、Esc / 点外部关闭。
 *
 * ⚠️ 条目上 `onMouseDown` 先 preventDefault：不抢走编辑器的焦点与
 * DOM 选区，令牌才能插回用户原来的光标位置（浮层工具栏的标准做法）。
 */
export function PromptMentionMenu({
  activeIndex,
  hasSelection,
  onPick,
  onClose
}: {
  /** 键盘高亮的条目下标 */
  activeIndex: number;
  /** 终端当前有无选区（「选中内容」项据此置灰） */
  hasSelection: boolean;
  onPick: (
    item: (typeof TERMINAL_REF_ITEMS)[number]
  ) => void;
  onClose: () => void;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭（与「+」菜单同一套兜底）
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (
        !rootRef.current?.contains(
          event.target as Node
        )
      )
        onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener(
      "pointerdown",
      onDown
    );
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener(
        "pointerdown",
        onDown
      );
      document.removeEventListener(
        "keydown",
        onKey
      );
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className={`${menuStyles.menu} ${menuStyles.menuMention}`}
      role="listbox"
      aria-label={t("ai.ref.title")}
    >
      {TERMINAL_REF_ITEMS.map((item, index) => {
        // 无选区时「选中内容」不可用 —— 置灰而不是藏掉：
        // 藏掉用户不知道有这个能力
        const disabled =
          item.kind === "selection" &&
          !hasSelection;
        return (
          <button
            key={item.kind}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            aria-disabled={disabled || undefined}
            className={
              index === activeIndex
                ? `${menuStyles.menuItem} ${menuStyles.menuItemActive}`
                : menuStyles.menuItem
            }
            onMouseDown={event =>
              event.preventDefault()
            }
            onClick={() => {
              if (!disabled) onPick(item);
            }}
          >
            <span className={menuStyles.menuName}>
              {t(item.labelKey)}
              {disabled &&
                `（${t("ai.ref.selectionEmpty")}）`}
            </span>
            <span
              className={menuStyles.menuToken}
            >
              {item.token}
            </span>
          </button>
        );
      })}
    </div>
  );
}
