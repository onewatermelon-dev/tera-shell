"use client";

/**
 * AI 输入框（改造自 @aicss/react 的 PromptInput，MIT 许可）。
 *
 * 相比原组件的裁剪：
 * - 附件上传改为仅图片（「+」菜单选文件 → data URL 交给父级随消息发送）；
 *   移除 Skills 斜杠面板、Enhance Prompt 假流程（本项目无此能力）；
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
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { useT } from "@/settings/lib/i18n";
import styles from "./PromptInput.module.css";

export type PromptModel = {
  /** 稳定 id：providerId::modelId */
  id: string;
  /** 模型展示名（浮层里一行一个） */
  name: string;
  /** 供应商名：主菜单按它分组，一行一个供应商 */
  provider: string;
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
  /** 待发送的图片（data URL），由父级持有；发送后由父级清空 */
  images: string[];
  /** 选图完成：读出 data URL 列表交给父级 */
  onAddImages: (urls: string[]) => void;
  onRemoveImage: (index: number) => void;
  /** 引擎忙时禁止发送 */
  busy: boolean;
  placeholder: string;
  /** 用户按下发送（Enter 或点击箭头），参数为编辑器纯文本 */
  onSend: (value: string) => void;
};

/** 菜单行共用的选中对勾图标。 */
function CheckIcon() {
  return (
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
  );
}

/** 单张图上限：base64 进请求体，超大图直接拒收。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 文件 → data URL；非图片或超限返回 null。 */
async function fileToDataUrl(
  file: File
): Promise<string | null> {
  if (
    !file.type.startsWith("image/") ||
    file.size > MAX_IMAGE_BYTES
  ) {
    console.warn(
      "[ai-image] 跳过不支持的文件",
      file.name,
      file.type,
      file.size
    );
    return null;
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result));
    reader.onerror = () => {
      console.warn(
        "[ai-image] 读取失败",
        file.name
      );
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

export function PromptInput({
  models,
  modelId,
  onModelChange,
  autoExecute,
  onAutoExecuteChange,
  autoApply,
  onAutoApplyChange,
  images,
  onAddImages,
  onRemoveImage,
  busy,
  placeholder,
  onSend
}: PromptInputProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const plusWrapRef =
    useRef<HTMLDivElement>(null);
  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const pickImages = async (
    event: ReactChangeEvent<HTMLInputElement>
  ) => {
    const files = Array.from(
      event.target.files ?? []
    );
    // 先清空 input，重选同一张图也能触发 change
    event.target.value = "";
    const urls = await Promise.all(
      files.map(fileToDataUrl)
    );
    const accepted = urls.filter(
      (url): url is string => url !== null
    );
    if (accepted.length) onAddImages(accepted);
  };

  // 浮层展开的供应商（null = 收起）。用 JS 状态 + 延迟关闭替代纯 CSS
  // :hover：斜向移动指针会短暂经过行与浮层之间的死区，hover 一断即收起
  const [openProvider, setOpenProvider] =
    useState<string | null>(null);
  const flyoutTimerRef = useRef<number | null>(
    null
  );

  const hoverProvider = (name: string) => {
    if (flyoutTimerRef.current !== null)
      window.clearTimeout(flyoutTimerRef.current);
    setOpenProvider(name);
  };

  const leaveProvider = () => {
    flyoutTimerRef.current = window.setTimeout(
      () => setOpenProvider(null),
      250
    );
  };

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
  // 只发图不发消息也允许发送
  const sendActive =
    (hasText || images.length > 0) && !busy;

  // 按供应商分组（保持传入顺序）：主菜单一行一个供应商，悬停展开模型浮层
  const providerGroups: Array<
    [string, PromptModel[]]
  > = [];
  for (const model of models) {
    const group = providerGroups.find(
      ([name]) => name === model.provider
    );
    if (group) group[1].push(model);
    else
      providerGroups.push([
        model.provider,
        [model]
      ]);
  }

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

        {images.length > 0 && (
          <div className={styles.attachments}>
            {images.map((url, index) => (
              <span
                key={`${index}-${url.slice(-24)}`}
                className={styles.thumb}
              >
                <img
                  src={url}
                  alt=""
                  className={styles.thumbImg}
                />
                <button
                  type="button"
                  className={styles.thumbRemove}
                  aria-label={t(
                    "ai.menu.removeImage"
                  )}
                  onClick={() =>
                    onRemoveImage(index)
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={event =>
            void pickImages(event)
          }
        />

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
              aria-label={t("ai.selectModel")}
              aria-expanded={menuOpen}
              onClick={() => {
                // 打开时复位浮层，避免还停在上次悬停的供应商行
                setOpenProvider(null);
                setMenuOpen(open => !open);
              }}
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
                  {t("ai.menu.attach")}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  title={t(
                    "ai.menu.uploadImageHint"
                  )}
                  onClick={() => {
                    setMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span
                    className={styles.menuName}
                  >
                    {t("ai.menu.uploadImage")}
                  </span>
                </button>
                <div className={styles.menuLabel}>
                  {t("ai.menu.exec")}
                </div>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={autoExecute}
                  className={styles.menuItem}
                  title={t(
                    "ai.menu.autoExecuteHint"
                  )}
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
                    {t("ai.menu.autoExecute")}
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
                  title={t(
                    "ai.menu.autoApplyHint"
                  )}
                  onClick={() =>
                    onAutoApplyChange(!autoApply)
                  }
                >
                  <span
                    className={styles.menuName}
                  >
                    {t("ai.menu.autoApply")}
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
                  {t("ai.menu.model")}
                </div>
                {models.length === 0 && (
                  <div
                    className={styles.menuLabel}
                  >
                    {t("ai.noModel")}
                  </div>
                )}
                {providerGroups.map(
                  ([provider, list]) => (
                    <div
                      key={provider}
                      className={styles.menuSub}
                      data-open={
                        openProvider ===
                          provider || undefined
                      }
                      onMouseEnter={() =>
                        hoverProvider(provider)
                      }
                      onMouseLeave={leaveProvider}
                    >
                      {/* 供应商行：悬停在右侧展开模型浮层 */}
                      <div
                        className={
                          styles.menuItem
                        }
                      >
                        <span
                          className={
                            styles.menuName
                          }
                        >
                          {provider}
                        </span>
                        {list.some(
                          m => m.id === modelId
                        ) && (
                          <span
                            className={
                              styles.menuCheck
                            }
                          >
                            <CheckIcon />
                          </span>
                        )}
                        <span
                          className={
                            styles.menuChevron
                          }
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </span>
                      </div>
                      <div
                        className={
                          styles.menuFlyout
                        }
                        role="menu"
                      >
                        {list.map(model => (
                          <button
                            key={model.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={
                              modelId === model.id
                            }
                            className={
                              styles.menuItem
                            }
                            onClick={() => {
                              onModelChange(
                                model.id
                              );
                              setMenuOpen(false);
                            }}
                          >
                            <span
                              className={
                                styles.menuName
                              }
                            >
                              {model.name}
                            </span>
                            {modelId ===
                              model.id && (
                              <span
                                className={
                                  styles.menuCheck
                                }
                              >
                                <CheckIcon />
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                )}
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
              aria-label={t("ai.send")}
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
