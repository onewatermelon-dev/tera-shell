import {
  useEffect,
  useRef,
  useState
} from "react";
import { Button } from "@heroui/react";
import { PlusOutlined } from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import { useT } from "@/settings/lib/i18n";
import MacroContextMenu, {
  type MacroAction
} from "@/terminal/components/MacroContextMenu";
import type { TerminalMacro } from "@/terminal/lib/terminalMacros";

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
  /** 拖拽换位：把 id 插到 beforeId 之前，null 表示挪到末尾。 */
  onReorder: (
    id: string,
    beforeId: string | null
  ) => void;
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
  onDelete,
  onReorder
}: MacroBarProps) {
  const t = useT();
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

  // 拖拽刚结束标记：RAC 的 press 也在 pointerup 上完成（冒泡阶段），
  // 不吞掉就会"拖完顺手执行了宏"。capture 的 pointerup 先置位、宏任务复位。
  const draggedRef = useRef(false);

  /**
   * 拖拽换位：与标签拖拽（TerminalWorkspace.startTabDrag）同一套手写指针 ——
   * RAC 的 press 在 pointerdown 上 preventDefault，原生 HTML5 拖拽起不来。
   * 按下后移动超 6px 才算拖，松手按落点宏的中线插到其前/后；落在宏外＝取消。
   */
  function startMacroDrag(
    event: React.MouseEvent,
    macro: TerminalMacro
  ) {
    if (event.button !== 0) return;
    // 与标签拖拽同款：不拦 mousedown 就会起原生文本拖拽，浏览器随即用
    // pointercancel 掐掉后续 pointer 事件，换位逻辑永远收不到松手
    event.preventDefault();
    const id = macro.id;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    // 跟手浮标：与标签拖拽同一个 .tab-drag-ghost 样式，纯 DOM 移动不进渲染
    let ghost: HTMLElement | null = null;
    const onMove = (ev: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(
          ev.clientX - startX,
          ev.clientY - startY
        ) > 6
      ) {
        dragging = true;
        document.body.classList.add(
          "tab-dragging"
        );
        ghost = document.createElement("div");
        ghost.className = "tab-drag-ghost";
        ghost.textContent = macro.name;
        document.body.appendChild(ghost);
      }
      if (ghost)
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
      ev.preventDefault();
    };
    const cleanup = () => {
      window.removeEventListener(
        "pointermove",
        onMove
      );
      window.removeEventListener(
        "pointerup",
        onUp,
        true
      );
      window.removeEventListener(
        "pointercancel",
        onCancel,
        true
      );
      ghost?.remove();
      document.body.classList.remove(
        "tab-dragging"
      );
    };
    const onUp = (ev: MouseEvent) => {
      cleanup();
      if (!dragging) return;
      ev.preventDefault();
      // 标记本次松手是拖拽：吞掉同一手势随后补到的 press（误执行宏）
      draggedRef.current = true;
      setTimeout(() => {
        draggedRef.current = false;
      }, 0);
      // 落点按宏列表整体判定 —— 不要求必须压在某只按钮上：
      // 落在两只宏的缝隙/空白同样换位，只有拖出列表才取消。
      // 插入锚点 = 落点左边最近一只宏（过其中线则算它右边那只）
      const list = listRef.current;
      const under = document.elementFromPoint(
        ev.clientX,
        ev.clientY
      );
      if (
        !list ||
        !under ||
        !list.contains(under)
      )
        return;
      let beforeId: string | null = null;
      for (const item of list.querySelectorAll<HTMLElement>(
        "[data-macro-id]"
      )) {
        const rect = item.getBoundingClientRect();
        if (
          ev.clientX <
          rect.left + rect.width / 2
        ) {
          beforeId = item.getAttribute(
            "data-macro-id"
          );
          break;
        }
      }
      if (beforeId !== id)
        onReorder(id, beforeId);
    };
    // 指针被系统抢走（原生拖拽、手势打断等）：只清理，不换位 ——
    // 不接 pointercancel 的话监听器会一直挂在 window 上越积越多
    const onCancel = () => cleanup();
    window.addEventListener(
      "pointermove",
      onMove
    );
    // capture：抢在按钮自己的 press（冒泡）之前看到松手
    window.addEventListener(
      "pointerup",
      onUp,
      true
    );
    window.addEventListener(
      "pointercancel",
      onCancel,
      true
    );
  }

  /** 右键菜单选中的动作；菜单自己会在选完后关闭。 */
  function handleAction(action: MacroAction) {
    if (!menu) return;
    if (action === "edit") onEdit(menu.macro);
    else onDelete(menu.macro);
  }

  return (
    <div className="status-macros" ref={barRef}>
      {/* 宏区贴窗口底边，提示必须向上弹，向下会跑到窗口外 */}
      <Hint
        label={t("macro.add")}
        placement="top"
      >
        <Button
          className="macro-btn macro-add"
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={t("macro.add")}
          onPress={onAdd}
        >
          <PlusOutlined />
        </Button>
      </Hint>
      {/* 只有宏本身滚动，+ 号留在原地 —— 否则宏一多就加不了新宏了 */}
      <div className="macro-list" ref={listRef}>
        {macros.map(macro => (
          // data-macro-id 供松手时反查"落在了哪个宏上"。注意：拖拽的
          // onMouseDown 必须挂在 Button 自身 —— RAC Button 的内部 press
          // 会对 mousedown stopPropagation，父级 div 永远收不到。
          <div
            key={macro.id}
            className="macro-item"
            data-macro-id={macro.id}
          >
            <Button
              className="macro-btn"
              variant="ghost"
              size="sm"
              isDisabled={disabled}
              aria-label={t("macro.run", {
                command: macro.command
              })}
              onMouseDown={event =>
                startMacroDrag(event, macro)
              }
              onPress={() => {
                // 刚完成一次拖拽：吞掉这一下误触发的 press
                if (draggedRef.current) return;
                onRun(macro);
              }}
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
          </div>
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
