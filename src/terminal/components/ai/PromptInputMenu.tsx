"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { useT } from "@/settings/lib/i18n";
import controlStyles from "./PromptInputControls.module.css";
import menuStyles from "./PromptInputMenu.module.css";
import {
  CheckIcon,
  FileCheckIcon,
  ImageIcon,
  PlayIcon
} from "./PromptInputIcons";
import type { PromptModel } from "./PromptInput";

/**
 * 「+」菜单：上传图片 / 自动执行 / 自动应用 / 黑名单 / 选模型。
 *
 * 供应商分组（保持传入顺序）一行一个，悬停右侧展开模型浮层。
 * 浮层展开态用 JS 状态 + 延迟关闭替代纯 CSS :hover：斜向移动指针会
 * 短暂经过行与浮层之间的死区，hover 一断即收起。
 * 菜单打开时挂 document 级 pointerdown / keydown 兜底关闭。
 */
export function PromptInputMenu({
  menuOpen,
  setMenuOpen,
  onPickImage,
  models,
  modelId,
  onModelChange,
  autoExecute,
  onAutoExecuteChange,
  autoApply,
  onAutoApplyChange,
  onOpenBlacklist
}: {
  menuOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  /** 选「上传图片」：父级触发隐藏的 file input */
  onPickImage: () => void;
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
}) {
  const t = useT();
  const plusWrapRef =
    useRef<HTMLDivElement>(null);

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
  }, [menuOpen, setMenuOpen]);

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

  return (
    <div
      className={controlStyles.plusWrap}
      ref={plusWrapRef}
    >
      <button
        type="button"
        className={[
          controlStyles.iconBtn,
          controlStyles.plus
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
        <span className={controlStyles.plusIcon}>
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
          className={menuStyles.menu}
          role="menu"
        >
          <div className={menuStyles.menuLabel}>
            {t("ai.menu.attach")}
          </div>
          <button
            type="button"
            role="menuitem"
            className={menuStyles.menuItem}
            title={t("ai.menu.uploadImageHint")}
            onClick={() => {
              setMenuOpen(false);
              onPickImage();
            }}
          >
            <ImageIcon />
            <span className={menuStyles.menuName}>
              {t("ai.menu.uploadImage")}
            </span>
          </button>
          <div className={menuStyles.menuLabel}>
            {t("ai.menu.exec")}
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoExecute}
            className={menuStyles.menuItem}
            title={t("ai.menu.autoExecuteHint")}
            onClick={() => {
              // 开启会弹安全确认框，先把菜单收起
              setMenuOpen(false);
              onAutoExecuteChange(!autoExecute);
            }}
          >
            <PlayIcon />
            <span className={menuStyles.menuName}>
              {t("ai.menu.autoExecute")}
            </span>
            {autoExecute && (
              <span
                className={menuStyles.menuCheck}
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
            className={menuStyles.menuItem}
            title={t("ai.menu.autoApplyHint")}
            onClick={() =>
              onAutoApplyChange(!autoApply)
            }
          >
            <FileCheckIcon />
            <span className={menuStyles.menuName}>
              {t("ai.menu.autoApply")}
            </span>
            {autoApply && (
              <span
                className={menuStyles.menuCheck}
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
            className={menuStyles.menuItem}
            title={t("ai.menu.blacklistHint")}
            onClick={() => {
              setMenuOpen(false);
              onOpenBlacklist();
            }}
          >
            <span
              className={
                menuStyles.menuIconSpacer
              }
              aria-hidden="true"
            />
            <span className={menuStyles.menuName}>
              {t("ai.menu.blacklist")}
            </span>
          </button>
          <div className={menuStyles.menuLabel}>
            {t("ai.menu.model")}
          </div>
          {models.length === 0 && (
            <div className={menuStyles.menuLabel}>
              {t("ai.noModel")}
            </div>
          )}
          {providerGroups.map(
            ([provider, list]) => (
              <div
                key={provider}
                className={menuStyles.menuSub}
                data-open={
                  openProvider === provider ||
                  undefined
                }
                onMouseEnter={() =>
                  hoverProvider(provider)
                }
                onMouseLeave={leaveProvider}
              >
                {/* 供应商行：悬停在右侧展开模型浮层 */}
                <div
                  className={menuStyles.menuItem}
                >
                  {/* 无图标行垫同宽占位，文字与上方图标行对齐 */}
                  <span
                    className={
                      menuStyles.menuIconSpacer
                    }
                    aria-hidden="true"
                  />
                  <span
                    className={
                      menuStyles.menuName
                    }
                  >
                    {provider}
                  </span>
                  {list.some(
                    m => m.id === modelId
                  ) && (
                    <span
                      className={
                        menuStyles.menuCheck
                      }
                    >
                      <CheckIcon />
                    </span>
                  )}
                  <span
                    className={
                      menuStyles.menuChevron
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
                    menuStyles.menuFlyout
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
                        menuStyles.menuItem
                      }
                      onClick={() => {
                        onModelChange(model.id);
                        setMenuOpen(false);
                      }}
                    >
                      <span
                        className={
                          menuStyles.menuName
                        }
                      >
                        {model.name}
                      </span>
                      {modelId === model.id && (
                        <span
                          className={
                            menuStyles.menuCheck
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
  );
}
