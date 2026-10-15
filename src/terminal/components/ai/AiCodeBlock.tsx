"use client";

/**
 * AI 回答里的代码块：外观来自 @aicss/react 的 CodeBlock（MIT 许可，
 * 源码见 node_modules/@aicss/react/src/code-block/CodeBlock.tsx），
 * 按项目惯例改造（同 PromptInput / ReasoningBlock）：
 *
 * - **保留** aicss 的卡片外观：圆角卡片、头部（代码图标 + 语言标签）、
 *   行号 + 左侧分隔线、复制钮，以及整套明暗主题变量；
 * - **加语法着色**：aicss 原版是纯等宽渲染，本项目自带的 cli-highlight
 *   管线（codeHighlight.ts）不能丢 —— token 的浅色值直接上色，深色值
 *   走 `--shiki-dark` 内联变量，一套 token 服务明暗两套配色；
 * - **加「另存为」**：WebView2 丢原生下载（见 streamdownExport.ts 的
 *   说明），这里直接调 `fs_save_text_file` 弹系统框。以前那是靠
 *   document 捕获 hack 接管 Streamdown 内部按钮，现在按钮是自己的，
 *   不需要 hack。
 * - **纯图标按钮**：复制/另存为只放图标，不挂文字也不挂气泡
 *   （Hint/title 都别加）—— 可读性靠 aria-label 兜底。
 *
 * ⚠️ 高亮是**异步**的（cli-highlight 动态 import）：首帧无色，token
 * 到了再重渲。请求序号防串台 —— 流式期间 code 每帧都变，迟到的旧结果
 * 不能覆盖新内容。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "@/settings/lib/i18n";
import styles from "./AiCodeBlock.module.css";
import {
  createTokenSource,
  type HighlightToken
} from "@/terminal/lib/codeHighlight";
import { codeBlockFileName } from "@/terminal/lib/streamdownExport";

/** token 的内联样式：两个自定义属性，取值规则见 CSS 里 .cbTok */
type TokenStyle = CSSProperties & {
  "--sdm-c"?: string;
  "--shiki-dark"?: string;
};

export function AiCodeBlock({
  lang,
  code
}: {
  /** 围栏信息串里的语言（已由 fillCodeFenceLanguage 补过默认值） */
  lang: string;
  /** 代码正文（不含末尾换行） */
  code: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [saveFailed, setSaveFailed] =
    useState(false);
  // 高亮源整个生命周期只建一次：缓存与 cli-highlight 的动态 import
  // 都在里面，每次渲染新建等于缓存全废
  const [source] = useState(createTokenSource);
  const [tokens, setTokens] = useState<
    HighlightToken[][] | null
  >(null);
  // 请求序号：流式期间 code 每帧都变，迟到的旧结果不能覆盖新内容
  const requestRef = useRef(0);

  useEffect(() => {
    const request = (requestRef.current += 1);
    const sync = source.get(code, lang, next => {
      if (requestRef.current === request)
        setTokens(next);
    });
    // 命中缓存同步给；没就绪先置 null（等异步回调）
    if (requestRef.current === request)
      setTokens(sync);
  }, [source, code, lang]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [code]);

  const save = useCallback(() => {
    setSaveFailed(false);
    invoke<string | null>("fs_save_text_file", {
      content: code,
      suggestedName: codeBlockFileName(lang)
    })
      .then(path => {
        if (path)
          console.info(
            `[ai] 代码已保存到 ${path}`
          );
        else
          console.info("[ai] 用户取消了另存为");
      })
      .catch(reason => {
        // 保存失败不冒面板气泡（那条路是给 Streamdown 内部按钮的
        // hack 用的），这里按钮自己闪一下 + 控制台留痕
        console.error(
          "[ai] 代码另存为失败",
          reason
        );
        setSaveFailed(true);
      });
  }, [code, lang]);

  // 着色未就绪（首帧 / 动态 import 中）：按纯文本行渲染，
  // 行号与最终形态一致，不会跳版
  const lines: HighlightToken[][] =
    tokens ??
    code
      .split("\n")
      .map<HighlightToken[]>(line => [
        { content: line }
      ]);

  return (
    <div className={styles.cb}>
      <div className={styles.cbHead}>
        <span className={styles.cbFile}>
          <svg
            className={styles.cbIcon}
            viewBox="0 0 24 24"
            width="15"
            height="15"
            aria-hidden="true"
          >
            <path
              d="m8 6-6 6 6 6M16 6l6 6-6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className={styles.cbLang}>
            {lang}
          </span>
        </span>
        {/* 纯图标按钮：不放文字也不挂气泡（Hint/title 都不要）——
            可读性靠 aria-label（读屏软件）兜底 */}
        <button
          type="button"
          className={styles.cbCopy}
          onClick={copy}
          aria-label={
            copied
              ? t("ai.code.copied")
              : t("ai.code.copy")
          }
        >
          {copied ? (
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect
                x="9"
                y="9"
                width="11"
                height="11"
                rx="2.5"
              />
              <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={styles.cbCopy}
          onClick={save}
          aria-label={
            saveFailed
              ? t("ai.code.saveFailed")
              : t("ai.code.save")
          }
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </button>
      </div>
      <div className={styles.cbBody}>
        <div className={styles.cbLines}>
          {lines.map((line, row) => (
            <div
              className={styles.cbRow}
              key={row}
            >
              <span className={styles.cbLn}>
                {row + 1}
              </span>
              <code className={styles.cbCode}>
                {line.map((token, col) => {
                  const dark =
                    token.htmlStyle?.[
                      "--shiki-dark"
                    ];
                  const style: TokenStyle = {
                    ...(token.color
                      ? { "--sdm-c": token.color }
                      : {}),
                    ...(dark
                      ? { "--shiki-dark": dark }
                      : {})
                  };
                  return (
                    <span
                      key={col}
                      className={styles.cbTok}
                      style={style}
                    >
                      {token.content || "\u00A0"}
                    </span>
                  );
                })}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
