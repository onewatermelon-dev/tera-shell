"use client";

/**
 * AI 输入框（改造自 @aicss/react 的 PromptInput，MIT 许可）。
 *
 * 相比原组件的裁剪：
 * - 移除附件上传、Skills 斜杠面板、Enhance Prompt 假流程（本项目无此能力）；
 * - 移除 lucide-react 依赖，用到的图标改为内联 SVG；
 * - 内置的演示模型列表换成 props 传入的真实模型清单。
 *
 * 保留：contentEditable 编辑器（placeholder / Enter 发送 / Shift+Enter 换行）、
 * 「+」菜单里的模型选择、圆角发送钮。
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import styles from "./PromptInput.module.css";

export type PromptModel = {
  /** 稳定 id：providerId::modelId */
  id: string;
  /** 下拉展示名 */
  name: string;
};

type PromptInputProps = {
  models: PromptModel[];
  /** 当前选中的模型 id */
  modelId: string;
  onModelChange: (id: string) => void;
  /** 只读命令自动执行（关闭则也需手动确认） */
  autoExecute: boolean;
  onAutoExecuteChange: (value: boolean) => void;
  /** 文件更改（读写命令）自动应用（关闭则需手动点击执行） */
  autoApply: boolean;
  onAutoApplyChange: (value: boolean) => void;
  /** 引擎忙时禁止发送 */
  busy: boolean;
  placeholder: string;
  /** 用户按下发送（Enter 或点击箭头），参数为编辑器纯文本 */
  onSend: (value: string) => void;
};

export function PromptInput({
  models,
  modelId,
  onModelChange,
  autoExecute,
  onAutoExecuteChange,
  autoApply,
  onAutoApplyChange,
  busy,
  placeholder,
  onSend
}: PromptInputProps) {
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const plusWrapRef =
    useRef<HTMLDivElement>(null);

  // 模型菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (
        !plusWrapRef.current?.contains(
          event.target as Node
        )
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        setMenuOpen(false);
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
  }, [menuOpen]);

  const hasText = value.trim().length > 0;
  const sendActive = hasText && !busy;

  const syncFromEditor = () => {
    setValue(
      editorRef.current?.textContent ?? ""
    );
  };

  const onEditorKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      // Shift+Enter 换行；Enter 直接发送
      event.preventDefault();
      send();
    }
  };

  const send = () => {
    if (!sendActive) return;
    const text = value;
    if (editorRef.current) {
      editorRef.current.innerHTML = "";
    }
    setValue("");
    setMenuOpen(false);
    requestAnimationFrame(() =>
      editorRef.current?.focus()
    );
    onSend(text);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.frame}>
        <div className={styles.editorWrap}>
          <div
            ref={editorRef}
            className={styles.field}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder}
            data-empty={!hasText || undefined}
            data-placeholder={placeholder}
            data-disabled={busy || undefined}
            onInput={syncFromEditor}
            onKeyDown={onEditorKeyDown}
          />
        </div>

        <div className={styles.row}>
          <div
            className={styles.plusWrap}
            ref={plusWrapRef}
          >
            <button
              type="button"
              className={[
                styles.iconBtn,
                styles.plus
              ].join(" ")}
              data-open={menuOpen || undefined}
              aria-label="切换模型"
              aria-expanded={menuOpen}
              onClick={() =>
                setMenuOpen(open => !open)
              }
            >
              <span className={styles.plusIcon}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
            </button>

            {menuOpen && (
              <div
                className={styles.menu}
                role="menu"
              >
                <div className={styles.menuLabel}>
                  执行
                </div>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={autoExecute}
                  className={styles.menuItem}
                  title="开启后只读命令自动执行，无需手动确认"
                  onClick={() => {
                    // 开启会弹安全确认框，先把菜单收起
                    setMenuOpen(false);
                    onAutoExecuteChange(
                      !autoExecute
                    );
                  }}
                >
                  <span
                    className={styles.menuName}
                  >
                    自动执行
                  </span>
                  {autoExecute && (
                    <span
                      className={styles.menuCheck}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={autoApply}
                  className={styles.menuItem}
                  title="开启后文件更改自动应用，无需手动点击执行"
                  onClick={() =>
                    onAutoApplyChange(!autoApply)
                  }
                >
                  <span
                    className={styles.menuName}
                  >
                    自动应用
                  </span>
                  {autoApply && (
                    <span
                      className={styles.menuCheck}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                  )}
                </button>
                <div className={styles.menuLabel}>
                  模型
                </div>
                {models.length === 0 && (
                  <div
                    className={styles.menuLabel}
                  >
                    未配置模型
                  </div>
                )}
                {models.map(model => (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={
                      modelId === model.id
                    }
                    className={styles.menuItem}
                    onClick={() => {
                      onModelChange(model.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span
                      className={styles.menuName}
                    >
                      {model.name}
                    </span>
                    {modelId === model.id && (
                      <span
                        className={
                          styles.menuCheck
                        }
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.right}>
            <button
              type="button"
              className={[
                styles.iconBtn,
                styles.send,
                sendActive && styles.sendActive
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label="发送"
              disabled={!sendActive}
              onClick={send}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
