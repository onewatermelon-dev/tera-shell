import { useEffect, useState } from "react";
import { useT } from "@/settings/lib/i18n";

/** 菜单与视口边缘之间保留的间隙。 */
const VIEWPORT_MARGIN = 8;

/** 标签右键菜单的动作。 */
export type TabAction =
  | "close"
  | "closeRight"
  | "closeOthers"
  | "closeAll"
  | "split";

type TabContextMenuProps = {
  /** 菜单左上角坐标（视口坐标，用 fixed 定位） */
  x: number;
  y: number;
  /** 该标签右侧是否还有其它标签：没有时「关闭右侧」置灰。 */
  canCloseRight: boolean;
  /** 被右键的会话是否还能向右拆分：已有拆分栏时隐藏该项。 */
  canSplit: boolean;
  onAction: (action: TabAction) => void;
  onClose: () => void;
};

/**
 * 会话标签的右键菜单：关闭类动作 + 分隔线 + 拆分（VSCode 式）。
 *
 * 与 MacroContextMenu 同一套做法 —— 位置修正在 ref 回调里量一次，
 * 点击菜单外或按 Esc 关闭。容器样式与文件菜单共享选择器。
 */
export default function TabContextMenu({
  x,
  y,
  canCloseRight,
  canSplit,
  onAction,
  onClose
}: TabContextMenuProps) {
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
      if (!target.closest(".tab-context-menu")) {
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
    action: TabAction,
    label: string,
    options: {
      strong?: boolean;
      disabled?: boolean;
    } = {}
  ) {
    return (
      <button
        key={action}
        type="button"
        disabled={options.disabled}
        className={
          options.strong
            ? "context-menu-item context-menu-item--strong"
            : "context-menu-item"
        }
        onClick={() => {
          if (options.disabled) return;
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
      className="tab-context-menu"
      style={{
        left: x,
        top: y,
        transform: `translate(${shift.x}px, ${shift.y}px)`
      }}
    >
      {renderItem(
        "close",
        t("terminal.closeTab")
      )}
      {renderItem(
        "closeRight",
        t("terminal.closeRight"),
        {
          disabled: !canCloseRight
        }
      )}
      {renderItem(
        "closeOthers",
        t("terminal.closeOthers")
      )}
      {/* 关闭所有不可撤销，放最后并用强调色 */}
      {renderItem(
        "closeAll",
        t("terminal.closeAll"),
        {
          strong: true
        }
      )}
      {/* 分隔线之后是布局类动作：VSCode 式向右拆分，可连续拆；
          关拆分栏不走菜单 —— 拆分标签上的 × 是唯一入口 */}
      {canSplit && (
        <>
          <div className="context-menu-separator" />
          {renderItem(
            "split",
            t("terminal.splitRight")
          )}
        </>
      )}
    </div>
  );
}
