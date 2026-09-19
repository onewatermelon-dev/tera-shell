import { useEffect, useState } from "react";
import { useT } from "@/settings/lib/i18n";

/** 菜单与视口边缘之间保留的间隙。 */
const VIEWPORT_MARGIN = 8;

/** 宏的右键菜单只有两个动作，删除不可撤销所以放在最后。 */
export type MacroAction = "edit" | "delete";

type MacroContextMenuProps = {
  /** 菜单左上角坐标（视口坐标，用 fixed 定位） */
  x: number;
  y: number;
  onAction: (action: MacroAction) => void;
  onClose: () => void;
};

/**
 * 快捷宏的右键菜单：编辑 / 删除。
 *
 * 与 FileContextMenu 同一套做法 —— 位置修正在 ref 回调里量一次，
 * 点击菜单外或按 Esc 关闭。这里只有两项，不需要分隔符和禁用态。
 */
export default function MacroContextMenu({
  x,
  y,
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
    strong = false
  ) {
    return (
      <button
        type="button"
        className={
          strong
            ? "context-menu-item context-menu-item--strong"
            : "context-menu-item"
        }
        onClick={() => {
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
      {renderItem(
        "delete",
        t("macro.deleteAction")
      )}
    </div>
  );
}
