import styles from "./ThinkingReasoning.module.css";
import { useRef, useState } from "react";
import { useT } from "@/settings/lib/i18n";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";

/**
 * 模型思考过程的可折叠展示块（数据驱动版，改造自 @aicss/react 的
 * ThinkingReasoning：原组件内置演示文案，这里改为接收真实的
 * reasoning_content，并去掉逐句揭示动画 —— 非流式场景下思考内容
 * 是一次性到达的）。
 *
 * 折叠时只显示「Thought for Ns」摘要头，展开后滚动查看全文；
 * 明暗主题跟随应用的 data-theme（CSS 模块内置了变量分支）。
 *
 * ⚠️ **思考内容也要过 sanitizeToolNames** —— 模型在 reasoning 里复述
 * 「我需要调用 run_command 查看」的概率比正文更高（那正是它在规划怎么
 * 调工具），用户点开折叠块看到的就是一串内部标识。
 */

/** 视口最大高度，超出后内部滚动 */
const MAX_VIEWPORT_PX = 180;

type ReasoningBlockProps = {
  /** 模型的思考内容（reasoning_content / thinking） */
  reasoning: string;
  /** 本次思考耗时（秒），展示在摘要头 */
  elapsedSeconds: number;
};

export function ReasoningBlock({
  reasoning,
  elapsedSeconds
}: ReasoningBlockProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const viewportRef =
    useRef<HTMLDivElement>(null);

  // ⚠️ 用 plain 模式：思考内容是纯文本渲染（`<p>`），没有「代码块」
  // 这回事。走markdown 模式会让模型自己写的 ``` 分段把后面的内容
  // 保护起来，工具名反而从这里漏出去。
  const paragraphs = sanitizeToolNames(
    reasoning,
    "plain"
  )
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && viewportRef.current) {
      viewportRef.current.scrollTop = 0;
    }
  };

  return (
    <div className={styles.tr}>
      <button
        type="button"
        className={`${styles.trHeader} ${styles.isClickable}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={styles.trLabel}>
          {t("ai.thoughtFor", {
            s: Math.max(
              1,
              Math.round(elapsedSeconds)
            )
          })}
        </span>
        <svg
          className={styles.trChevron}
          viewBox="0 0 24 24"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="m4.5 15.75 7.5-7.5 7.5 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        className={`${styles.trCollapsible} ${
          open ? "" : styles.isCollapsed
        }`}
      >
        <div className={styles.trInner}>
          <div
            ref={viewportRef}
            className={`${styles.trViewport} ${
              open ? styles.isScroll : ""
            }`}
            style={
              open
                ? {
                    maxHeight: `${MAX_VIEWPORT_PX}px`
                  }
                : undefined
            }
          >
            <div className={styles.trStream}>
              {paragraphs.map((line, index) => (
                <p
                  key={index}
                  className={styles.trSentence}
                >
                  {line}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
