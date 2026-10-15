import { useEffect, useState } from "react";
import { useT } from "@/settings/lib/i18n";

/** 菜单与视口边缘之间保留的间隙。 */
const VIEWPORT_MARGIN = 8;

/**
 * 宏的右键菜单有三个动作，删除不可撤销所以放在最后。
 *
 * `broadcast` 是写操作（会把命令下发到每个已打开标签），但不可撤销
 * 的风险低于删除，所以排在编辑之后、删除之前。
 */
export type MacroAction =
  "edit" | "broadcast" | "delete";

type MacroContextMenuProps = {
  /** 菜单左上角坐标（视口坐标，用 fixed 定位） */
  x: number;
  y: number;
  /** 「发送到所有标签」会落到的会话数；0 时该项置灰 */
  broadcastCount: number;
  onAction: (action: MacroAction) => void;
  onClose: () => void;
};

/**
 * 快捷宏的右键菜单：编辑 / 发送到所有标签 / 删除。
 *
 * 与 FileContextMenu 同一套做法 —— 位置修正在ref 回调里量一次，
 * 点击菜单外或按 Esc 关闭。
 */
export default function MacroContextMenu({
  x,
  y,
  broadcastCount,
  onAction,
  onClose
}: MacroContextMenuProps) {
  const t = useT();
  const [shift, setShift] = useState({
    x: 0,
    y: 0
  });
  const shifted = shift.x !== 0 || shift.y !== 0;

  function measure(node: HTMLDivElement | null) {
    if (!node || shifted) return;
    const rect = node.getBoundingClientRect();
    const overflowX =
      rect.right - window.innerWidth;
    const overflowY =
      rect.bottom - window.innerHeight;
    if (overflowX <= 0 && overflowY <= 0) return;
    setShift({
      // 同时保证修正后不会跑到视口左上角外面
      x:
        overflowX > 0
          ? -Math.min(
              overflowX + VIEWPORT_MARGIN,
              x - VIEWPORT_MARGIN
            )
          : 0,
      y:
        overflowY > 0
          ? -Math.min(
              overflowY + VIEWPORT_MARGIN,
              y - VIEWPORT_MARGIN
            )
          : 0
    });
  }

  // 点击菜单外或按 Esc 关闭
  useEffect(() => {
    const handlePointerDown = (
      event: MouseEvent
    ) => {
      const target = event.target as HTMLElement;
      if (
        !target.closest(".macro-context-menu")
      ) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener(
      "mousedown",
      handlePointerDown
    );
    document.addEventListener(
      "keydown",
      handleKey
    );
    return () => {
      document.removeEventListener(
        "mousedown",
        handlePointerDown
      );
      document.removeEventListener(
        "keydown",
        handleKey
      );
    };
  }, [onClose]);

  function renderItem(
    action: MacroAction,
    label: string,
    strong = false,
    /**
     * 悬停提示。
     *
     * 兼作两件事：置灰时说明为什么不能点（灰着不给解释比不给菜单项
     * 还让人困惑）；正常时补充文字里放不下的信息（如波及几个会话）。
     */
    hint?: string,
    disabled = false
  ) {
    // ⚠️ 置灰走 `disabled` 属性即可 —— `_context-menu.scss` 里是
    // `.context-menu-item:disabled`，不需要额外修饰类（写了也不生效）
    const className = strong
      ? "context-menu-item context-menu-item--strong"
      : "context-menu-item";
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        title={hint}
        onClick={() => {
          if (disabled) return;
          onAction(action);
          onClose();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      ref={measure}
      className="macro-context-menu"
      style={{
        left: x,
        top: y,
        transform: `translate(${shift.x}px, ${shift.y}px)`
      }}
    >
      {renderItem(
        "edit",
        t("macro.editAction"),
        true
      )}
      {/* 会话数放title 不放正文：正文一长菜单就被撑宽，
          整排项跟着变形。数量是「下嘴前确认波及范围」用的，
          悬停能看到就够，不必占正文位置。 */}
      {renderItem(
        "broadcast",
        t("macro.broadcastAction"),
        false,
        broadcastCount > 0
          ? t("macro.broadcastActionHint", {
              count: broadcastCount
            })
          : t("macro.broadcastEmpty"),
        broadcastCount === 0
      )}
      {renderItem(
        "delete",
        t("macro.deleteAction")
      )}
    </div>
  );
}
