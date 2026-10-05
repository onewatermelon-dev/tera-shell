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
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
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
  /** 打开自动执行黑名单配置弹窗 */
  onOpenBlacklist: () => void;
  /** 待发送的图片（data URL），由父级持有；发送后由父级清空 */
  images: string[];
  /** 选图完成：读出 data URL 列表交给父级 */
  onAddImages: (urls: string[]) => void;
  onRemoveImage: (index: number) => void;
  /** 引擎忙时禁止发送 */
  busy: boolean;
  /** 当前对话中已发送的文字问题，按发送顺序排列。 */
  history: string[];
  placeholder: string;
  /** 用户按下发送（Enter 或点击箭头），参数为编辑器纯文本 */
  onSend: (value: string) => void;
};

/** 菜单行图标统一规格：14px 描边 SVG，固定列宽保证文字对齐。 */
function MenuSvg({
  children
}: {
  children: ReactNode;
}) {
  return (
    <span className={styles.menuIcon}>
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
        {children}
      </svg>
    </span>
  );
}

/** 上传图片：山景图。 */
function ImageIcon() {
  return (
    <MenuSvg>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
      />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </MenuSvg>
  );
}

/** 自动执行：播放三角。 */
function PlayIcon() {
  return (
    <MenuSvg>
      <polygon points="6 3 20 12 6 21 6 3" />
    </MenuSvg>
  );
}

/** 自动应用：带对勾的文件。 */
function FileCheckIcon() {
  return (
    <MenuSvg>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="m9 15 2 2 4-4" />
    </MenuSvg>
  );
}

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

/** 在已发送问题间移动，并在越过最新一条时恢复未发送草稿。 */
export function stepPromptHistory(
  history: string[],
  current: number | null,
  draft: string,
  direction: "up" | "down"
): { index: number | null; value: string } {
  const next =
    direction === "up"
      ? Math.max(
          0,
          (current ?? history.length) - 1
        )
      : (current ?? history.length - 1) + 1;
  return next >= history.length
    ? { index: null, value: draft }
    : { index: next, value: history[next] ?? "" };
}

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
  onOpenBlacklist,
  images,
  onAddImages,
  onRemoveImage,
  busy,
  history,
  placeholder,
  onSend
}: PromptInputProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const historyIndexRef = useRef<number | null>(
    null
  );
  const draftRef = useRef("");
  const previousHistoryRef = useRef(history);
  const plusWrapRef =
    useRef<HTMLDivElement>(null);
  const fileInputRef =
    useRef<HTMLInputElement>(null);

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

  // 粘贴图片：剪贴板里有图片文件（截图直接 Ctrl+V）时收进待发送附件，
  // 纯文本粘贴不受影响
  const onEditorPaste = async (
    event: ReactClipboardEvent<HTMLDivElement>
  ) => {
    const files = Array.from(
      event.clipboardData.files
    ).filter(file =>
      file.type.startsWith("image/")
    );
    if (files.length === 0) return;
    event.preventDefault();
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
    if (!sendActive) return;
    const text = value;
    historyIndexRef.current = null;
    draftRef.current = "";
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
            onPaste={event =>
              void onEditorPaste(event)
            }
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
                  <ImageIcon />
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
                  <PlayIcon />
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
                  <FileCheckIcon />
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
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  title={t(
                    "ai.menu.blacklistHint"
                  )}
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenBlacklist();
                  }}
                >
                  <span
                    className={
                      styles.menuIconSpacer
                    }
                    aria-hidden="true"
                  />
                  <span
                    className={styles.menuName}
                  >
                    {t("ai.menu.blacklist")}
                  </span>
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
                        {/* 无图标行垫同宽占位，文字与上方图标行对齐 */}
                        <span
                          className={
                            styles.menuIconSpacer
                          }
                          aria-hidden="true"
                        />
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
