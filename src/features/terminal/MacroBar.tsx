import {
  useEffect,
  useRef,
  useState
} from "react";
import { Button } from "@heroui/react";
import { PlusOutlined } from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import MacroContextMenu, {
  type MacroAction
} from "@/features/terminal/MacroContextMenu";
import type { TerminalMacro } from "@/features/terminal/terminalMacros";

/** 右键菜单的状态：坐标 + 指向哪个宏。 */
type MenuState = {
  x: number;
  y: number;
  macro: TerminalMacro;
};

type MacroBarProps = {
  macros: TerminalMacro[];
  /** 没有活动会话时为真：按钮仍显示，但不可点 —— 点了也没处执行。 */
  disabled: boolean;
  /** 点击某个宏：把它的命令写进当前会话。 */
  onRun: (macro: TerminalMacro) => void;
  /** 点击 + ：弹出新增宏的窗口。 */
  onAdd: () => void;
  /** 右键菜单里的编辑。 */
  onEdit: (macro: TerminalMacro) => void;
  /** 右键菜单里的删除。 */
  onDelete: (macro: TerminalMacro) => void;
};

/**
 * 状态栏里的快捷宏区：[+] 加上若干命令按钮。
 *
 * 刻意**不单独占一行** —— 宏是随手的快捷方式，给它一行会持续压缩终端高度。
 * 挤在状态栏左侧，既常驻可见又不抢地方。
 */
export default function MacroBar({
  macros,
  disabled,
  onRun,
  onAdd,
  onEdit,
  onDelete
}: MacroBarProps) {
  const [menu, setMenu] =
    useState<MenuState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 监听挂在外层：鼠标停在 + 号上滚也能滑宏，不必非得对准列表
  const barRef = useRef<HTMLDivElement>(null);

  /**
   * 滚轮一律转成横向滚动：宏区只有横向可滚，鼠标停在它上面滚一下就是想
   * 看更多宏。自己改 scrollLeft 而不是交给浏览器默认行为 —— 后者在
   * 不同平台/设备上表现不一致，而且会连页面一起滚。
   *
   * React 的 onWheel 是 passive 的、没法 preventDefault，
   * 所以这里用原生监听并显式声明 passive: false。
   */
  useEffect(() => {
    const node = barRef.current;
    const list = listRef.current;
    if (!node || !list) return;
    const handleWheel = (event: WheelEvent) => {
      // 已经是横向的（触控板横扫、部分设备的 Shift+滚轮）优先用 deltaX
      const delta =
        event.deltaX !== 0
          ? event.deltaX
          : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      list.scrollLeft += delta;
    };
    node.addEventListener("wheel", handleWheel, {
      passive: false
    });
    return () =>
      node.removeEventListener(
        "wheel",
        handleWheel
      );
  }, []);

  /** 右键菜单选中的动作；菜单自己会在选完后关闭。 */
  function handleAction(action: MacroAction) {
    if (!menu) return;
    if (action === "edit") onEdit(menu.macro);
    else onDelete(menu.macro);
  }

  return (
    <div className="status-macros" ref={barRef}>
      {/* 宏区贴窗口底边，提示必须向上弹，向下会跑到窗口外 */}
      <Hint label="新增快捷宏" placement="top">
        <Button
          className="macro-btn macro-add"
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label="新增快捷宏"
          onPress={onAdd}
        >
          <PlusOutlined />
        </Button>
      </Hint>
      {/* 只有宏本身滚动，+ 号留在原地 —— 否则宏一多就加不了新宏了 */}
      <div className="macro-list" ref={listRef}>
        {macros.map(macro => (
          // 悬停提示显示完整命令：按钮上只放得下名字，
          // 但执行前应该能确认这条到底会跑什么
          <Hint
            key={macro.id}
            label={macro.command}
            placement="top"
          >
            <Button
              className="macro-btn"
              variant="ghost"
              size="sm"
              isDisabled={disabled}
              aria-label={`执行：${macro.command}`}
              onPress={() => onRun(macro)}
              // 右键：弹出编辑 / 删除。必须阻止默认菜单，否则会和系统的叠在一起
              onContextMenu={event => {
                event.preventDefault();
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  macro
                });
              }}
            >
              {macro.name}
            </Button>
          </Hint>
        ))}
      </div>
      {menu && (
        <MacroContextMenu
          x={menu.x}
          y={menu.y}
          onAction={handleAction}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
