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
 *
 * 按职责拆到同目录的几个模块，本文件只留组装：
 * - `promptInputUtils` 图片读取与历史召回的纯函数；
 * - `PromptInputIcons` 内联 SVG 图标；
 * - `usePromptEditor` 编辑器状态、↑/↓ 历史召回与 Enter 发送；
 * - `PromptInputMenu` 「+」菜单（附件 / 自动执行 / 自动应用 / 黑名单 / 选模型）；
 * - `PromptAttachments` 待发送图片缩略图条。
 */

import {
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent
} from "react";
import { useT } from "@/settings/lib/i18n";
import styles from "./PromptInput.module.css";
import controlStyles from "./PromptInputControls.module.css";
import { PromptInputMenu } from "./PromptInputMenu";
import { PromptAttachments } from "./PromptAttachments";
import { usePromptEditor } from "./usePromptEditor";
import { fileToDataUrl } from "./promptInputUtils";

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
  /** 当前对话中已发送的文字问题，按发送顺序排列。 */
  history: string[];
  placeholder: string;
  /** 用户按下发送（Enter 或点击箭头），参数为编辑器纯文本 */
  onSend: (value: string) => void;
  /**
   * 本轮是否还没结束 —— 即 `busy || pendingCardId`。
   *
   * ⚠️ **不能直接传 `busy`**：等工具确认卡片时 `runLoop` 会主动
   * `setBusy(false)`（否则卡片上的执行/跳过按钮会一直禁用），此刻模型
   * 仍挂起在本轮里、底部也仍属于「这一轮」。只判busy 的话按钮会在
   * 弹卡片那一刻退回发送态，看着能发消息，实际既没流也没循环。
   *
   * 它只切换图标与点击行为，**不影响可用性**（见下方 `buttonActive`）。
   */
  busy: boolean;
  /** 点停止键：中断本轮。生成中 / 等确认时才调用 */
  onStop: () => void;
};

// 历史召回是纯函数，实现搬到 promptInputUtils；这里再导出，
// 外部（含测试）仍从 PromptInput 引入
export { stepPromptHistory } from "./promptInputUtils";

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
  history,
  placeholder,
  onSend,
  busy,
  onStop
}: PromptInputProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const {
    hasText,
    canSend,
    editorRef,
    syncFromEditor,
    onEditorKeyDown,
    send
  } = usePromptEditor({
    history,
    images,
    onSubmit: text => {
      // 发送即收起「+」菜单（与原 send 内的时序一致：先收起再派发）
      setMenuOpen(false);
      onSend(text);
    }
  });

  // ⚠️ 这里**没有** busy 条件：AI 正在生成时用户仍应能按发送，消息由上层收进
  // 队列（见 aiChat.send）。早前 sendActive 里带了 `&& !busy`，发送按钮直接
  // disabled、Enter 也被 send() 的守卫吞掉 —— 用户的消息被静默丢弃，界面上毫无
  // 反馈。busy 改走「停止键」那条分支，两者互不干涉。
  const sendActive = canSend;
  // 生成中：这个键是停止键，必须**无条件可点**。哪怕输入框是空的（用户只想中断，
  // 不想发新消息），禁用了就等于没有停止按钮。
  const buttonActive = busy || sendActive;

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
            onInput={syncFromEditor}
            onKeyDown={onEditorKeyDown}
            onPaste={event =>
              void onEditorPaste(event)
            }
          />
        </div>

        {images.length > 0 && (
          <PromptAttachments
            images={images}
            onRemoveImage={onRemoveImage}
          />
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

        <div className={controlStyles.row}>
          <PromptInputMenu
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            onPickImage={() =>
              fileInputRef.current?.click()
            }
            models={models}
            modelId={modelId}
            onModelChange={onModelChange}
            autoExecute={autoExecute}
            onAutoExecuteChange={
              onAutoExecuteChange
            }
            autoApply={autoApply}
            onAutoApplyChange={onAutoApplyChange}
            onOpenBlacklist={onOpenBlacklist}
          />

          <div className={controlStyles.right}>
            {/* 生成中这一个键变「停止」：图标换成实心方块，点击走 onStop。
                ⚠️ 别把它 disabled 掉 —— 输入框为空时按钮Active 靠 busy 撑着，
                否则用户想中断却按不动。*/}
            <button
              type="button"
              className={[
                controlStyles.iconBtn,
                controlStyles.send,
                buttonActive &&
                  controlStyles.sendActive
              ]
                .filter(Boolean)
                .join(" ")}
              data-stop={busy || undefined}
              aria-label={
                busy ? t("ai.stop") : t("ai.send")
              }
              title={
                busy
                  ? t("ai.stopHint")
                  : undefined
              }
              disabled={!buttonActive}
              onClick={busy ? onStop : send}
            >
              {busy ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect
                    x="6"
                    y="6"
                    width="12"
                    height="12"
                    rx="1.5"
                  />
                </svg>
              ) : (
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
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
