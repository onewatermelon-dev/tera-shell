/**
 * 拖标签在窗格之间搬移 / 窗格内换位。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。原生 HTML5 拖放在
 * WebView2 里完全拖不动且不报错（本项目已踩过），所以手写 pointer
 * 拖拽：按下记录候选，移动超阈值才进拖拽，松开时按落点判定。
 * 选中不在这里做 —— 选中挂在按下那一下（onSelect），挂到 click /
 * 松手上会被手抖阈值和 preventDefault 吞掉。
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import type { OpenSession } from "@/terminal/lib/session/useTerminals";

export function startTabDrag(
  event: ReactMouseEvent,
  fromPaneId: string,
  id: string,
  deps: {
    /** 每个窗格的标签列表（换位时按它找锚点） */
    paneSessions: Map<string, OpenSession[]>;
    onMoveTab: (
      id: string,
      toPaneId: string
    ) => void;
    onFocusPane: (paneId: string) => void;
    onReorderTab: (
      paneId: string,
      id: string,
      beforeId: string | null
    ) => void;
  }
) {
  // 只响应主键；× 关闭钮自己会 stopPropagation，不会进到这里
  if (event.button !== 0) return;
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  const label =
    (
      event.currentTarget as HTMLElement
    ).textContent
      ?.replace("×", "")
      .trim() || "";

  const onMove = (ev: MouseEvent) => {
    if (
      !dragging &&
      Math.hypot(
        ev.clientX - startX,
        ev.clientY - startY
      ) > 6
    ) {
      dragging = true;
      document.body.classList.add("tab-dragging");
      ghost = document.createElement("div");
      ghost.className = "tab-drag-ghost";
      ghost.textContent = label;
      document.body.appendChild(ghost);
    }
    // 浮标中心对齐抓手：先移到指针位置，再回退自身一半宽高
    if (ghost)
      ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
    ev.preventDefault();
  };
  const onUp = (ev: MouseEvent) => {
    window.removeEventListener(
      "pointermove",
      onMove
    );
    window.removeEventListener("pointerup", onUp);
    ghost?.remove();
    document.body.classList.remove(
      "tab-dragging"
    );
    // 没超阈值＝按下那一下已经完成选中，这里不搬动
    if (!dragging) return;
    ev.preventDefault();
    // elementFromPoint 拿落点元素（标签被拖走后 pointer 命中的是
    // 别的元素，不能用 ev.target）
    const under = document.elementFromPoint(
      ev.clientX,
      ev.clientY
    );
    // 落点标签条：data-pane-tabs 就是窗格 id。落在标签条上任意空白处
    // （+ 按钮、溢出按钮那一带）同样算"进这个窗格"
    const hit = under?.closest(
      "[data-pane-tabs]"
    );
    if (!hit) return;
    const toPaneId = hit.getAttribute(
      "data-pane-tabs"
    );
    if (!toPaneId) return;
    // 跨窗格＝搬移；同窗格＝换位
    if (toPaneId !== fromPaneId) {
      deps.onMoveTab(id, toPaneId);
      deps.onFocusPane(toPaneId);
      return;
    }
    // 落点标签：指针过中线就插到它后面（取它右边那个标签当锚点，
    // 没有就是末尾）；落在空白处（最后一个标签右侧）＝追加到末尾
    const el = under?.closest(
      "[data-pane-tab-id]"
    ) as HTMLElement | null;
    let beforeId: string | null = null;
    if (el) {
      const rect = el.getBoundingClientRect();
      const after =
        ev.clientX > rect.left + rect.width / 2;
      const anchor = el.getAttribute(
        "data-pane-tab-id"
      );
      const list =
        deps.paneSessions.get(fromPaneId) ?? [];
      const index = list.findIndex(
        item => item.id === anchor
      );
      if (index >= 0)
        beforeId = after
          ? (list[index + 1]?.id ?? null)
          : anchor;
    }
    if (beforeId !== id)
      deps.onReorderTab(fromPaneId, id, beforeId);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
