import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  resolveDropTarget,
  type DropTarget,
  type DragPayload
} from "@/sftp/lib/dragTransfer";
import type {
  PaneEntry,
  PaneSide
} from "@/sftp/lib/useSftp";

/** 指针移动超过该距离才算拖动，避免与双击、点击冲突。 */
const DRAG_THRESHOLD = 6;

/** 拖拽过程中的对外状态。 */
export type PaneDragState = {
  /** 正在拖的条目路径集合（用于给源行加 data-dragging）。 */
  draggingPaths: string[];
  /** 当前落点；null 表示落在无效处（同栏 / 未加载），不显示任何高亮 */
  target: DropTarget | null;
};

/**
 * 双栏拖拽控制器。
 *
 * ⚠️ **必须用 pointer 事件，不能用 HTML5 的 draggable/dragover/drop**：
 * 那套依赖浏览器内置拖拽管线与 `dataTransfer`，在本项目的 Tauri WebView2
 * 里**完全拖不动且不报错、控制台干净**。本项目的两处拖拽（会话侧栏换组、
 * AI 排队换序）都因此改成了这套 pointer 方案。
 *
 * 三条铁律：
 * ① `pointermove` / `pointerup` 挂 **window** —— 指针移出列表也要收得到，
 *    否则拖到边缘松手就卡住不落；
 * ② **6px 位移阈值**才算拖动，纯点击不误触发；
 * ③ 落点用 `elementFromPoint` + `closest()`，**不能用 `event.target`**
 *    （被拖的行跟着指针走）。
 *
 * 跨窗口尾巴：拖出本窗口边界松手时栏内必然无落点，此时 pointerup
 * 仍会送达（拖拽窗口持有 OS 鼠标捕获），把条目连屏幕坐标交给
 * `onDropOutside` —— 宿主据此做「拖路径进终端」的跨窗口投递。
 */
export function usePaneDrag(options: {
  /** 落点确认：把来源栏的这些条目传进目标栏的该目录 */
  onDrop: (
    payload: DragPayload,
    target: DropTarget
  ) => void;
  /** 拖出本窗口边界松手：条目 + 光标屏幕坐标。 */
  onDropOutside?: (
    entries: PaneEntry[],
    screenX: number,
    screenY: number
  ) => void;
}) {
  const [state, setState] =
    useState<PaneDragState>({
      draggingPaths: [],
      target: null
    });

  // 拖拽过程中要读最新的回调，闭包里的旧值会失真
  const onDropRef = useRef(options.onDrop);
  /** 同上：出窗投递回调也要读最新的 */
  const onDropOutsideRef = useRef(
    options.onDropOutside
  );
  /** 拖拽起点所在栏与条目 —— pointerdown 时记，move/up 阶段要用 */
  const payloadRef = useRef<DragPayload | null>(
    null
  );
  /** 当前落点的 ref，供 pointerup 收尾时读（state 可能还没提交） */
  const targetRef = useRef<DropTarget | null>(
    null
  );

  // 拖拽过程中要读最新的回调，闭包里的旧值会失真。
  // ⚠️ 必须在 effect 里同步 —— eslint react-hooks/refs 不允许渲染期写 ref
  useEffect(() => {
    onDropRef.current = options.onDrop;
    onDropOutsideRef.current =
      options.onDropOutside;
  });

  /**
   * 从一行开始拖。
   *
   * 挂在行**本身**而不是单独的手柄：双栏文件列表的行没有操作按钮，
   * 整行拖更符合文件管理器的直觉（选中 + 拖走）。
   */
  const startDrag = useCallback(
    (
      from: PaneSide,
      entries: PaneEntry[],
      event: React.PointerEvent<HTMLElement>
    ) => {
      // 只响应主键；右键留给上下文菜单
      if (event.button !== 0) return;
      // 正在拖就别再起新的（上一轮的 pointerup 可能还没到）
      if (payloadRef.current) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let ghost: HTMLElement | null = null;

      payloadRef.current = { from, entries };

      const onDragMove = (ev: PointerEvent) => {
        if (!dragging) {
          const moved = Math.hypot(
            ev.clientX - startX,
            ev.clientY - startY
          );
          if (moved <= DRAG_THRESHOLD) return;
          dragging = true;
          setState({
            draggingPaths: entries.map(
              entry => entry.path
            ),
            target: null
          });
          ghost = buildGhost(entries);
          document.body.appendChild(ghost);
          document.body.classList.add(
            "sftp-dragging"
          );
          console.info(
            `[sftp] 开始拖动 ${entries.length} 个条目（${from}）`
          );
        }
        if (!ghost) return;
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
        const next = probeDrop(ev, from);
        // 落点没变就不重渲：pointermove 每帧都触发，
        // 无脑 setState 会把整份列表刷爆
        if (
          next?.entryPath !==
            targetRef.current?.entryPath ||
          next?.intoDirectory !==
            targetRef.current?.intoDirectory ||
          next?.pane !== targetRef.current?.pane
        ) {
          targetRef.current = next;
          setState(previous => ({
            ...previous,
            target: next
          }));
        }
        ev.preventDefault();
      };

      const onDragEnd = (ev: PointerEvent) => {
        window.removeEventListener(
          "pointermove",
          onDragMove
        );
        window.removeEventListener(
          "pointerup",
          onDragEnd
        );
        ghost?.remove();
        ghost = null;
        document.body.classList.remove(
          "sftp-dragging"
        );
        const payload = payloadRef.current;
        payloadRef.current = null;
        const target = targetRef.current;
        targetRef.current = null;
        setState({
          draggingPaths: [],
          target: null
        });
        // 没超过阈值 = 只是一次点击，让浏览器照常处理（双击进入等）
        if (!dragging) return;
        ev.preventDefault();
        if (payload && target) {
          console.info(
            `[sftp] 落点：${payload.from} → ${target.pane}:${target.intoDirectory}`
          );
          onDropRef.current(payload, target);
        } else {
          console.info(
            "[sftp] 拖放取消（无效落点）"
          );
          // 光标出了本窗口边界：栏内必然没有落点，交给宿主
          // 做跨窗口投递（拖路径进主窗口的终端）
          const entries = payload?.entries;
          if (
            entries?.length &&
            onDropOutsideRef.current &&
            (ev.screenX < window.screenX ||
              ev.screenX >
                window.screenX +
                  window.outerWidth ||
              ev.screenY < window.screenY ||
              ev.screenY >
                window.screenY +
                  window.outerHeight)
          ) {
            onDropOutsideRef.current(
              entries,
              ev.screenX,
              ev.screenY
            );
          }
        }
      };

      window.addEventListener(
        "pointermove",
        onDragMove
      );
      window.addEventListener(
        "pointerup",
        onDragEnd
      );
    },
    []
  );

  /** 某行是否处于「被拖」状态。 */
  const isDragging = useCallback(
    (path: string) =>
      state.draggingPaths.includes(path),
    [state.draggingPaths]
  );

  /** 某条目是否是当前落点（目录条目高亮成「放这里」）。 */
  const isTarget = useCallback(
    (path: string) =>
      state.target?.entryPath === path,
    [state.target]
  );

  /** 某栏是否是当前可落的那一栏（整栏描边提示）。 */
  const isPaneTarget = useCallback(
    (pane: PaneSide) =>
      state.target?.pane === pane,
    [state.target]
  );

  return {
    dragState: state,
    startDrag,
    isDragging,
    isTarget,
    isPaneTarget
  };
}

/**
 * 跟手浮标：显示条目数与首个名称。
 *
 * ⚠️ **必须 `pointer-events: none`** —— 否则 `elementFromPoint` 命中的是
 * 浮标自己，落点判定全废，症状是「拖到哪都不生效」。样式在
 * `_files.scss` 的 `.sftp-drag-ghost`。
 */
function buildGhost(
  entries: PaneEntry[]
): HTMLElement {
  const node = document.createElement("div");
  node.className = "sftp-drag-ghost";
  const first = entries[0];
  node.textContent =
    entries.length > 1
      ? `${first?.name ?? ""} 等 ${entries.length} 项`
      : (first?.name ?? "");
  return node;
}

/**
 * 取指针下的落点。
 *
 * `elementFromPoint` 命中的是行内某个单元格（文件名 / 大小 / 时间），
 * 所以要 `closest` 两层：先找行（拿 `data-entry-path` 与
 * `data-entry-dir`），再找栏（拿 `data-pane-side` 与
 * `data-pane-path`）。
 *
 * ⚠️ 命中行但读不到栏时返回 null（当作无效落点）：宁可不高亮，
 * 也别把条目判到错误的栏里去 —— 那会传错方向。
 */
function probeDrop(
  event: PointerEvent,
  from: PaneSide
): DropTarget | null {
  const under = document.elementFromPoint(
    event.clientX,
    event.clientY
  ) as HTMLElement | null;
  const paneEl = under?.closest(
    "[data-pane-side]"
  ) as HTMLElement | null;
  const pane = paneEl?.getAttribute(
    "data-pane-side"
  ) as PaneSide | null;
  if (!paneEl || !pane) return null;

  const rowEl = under?.closest(
    "[data-entry-path]"
  ) as HTMLElement | null;
  // 只用 DOM 上的两个属性拼一个最小条目：判定只需要 path + isDir，
  // 没必要把整份 listing 塞进属性里
  const entry: PaneEntry | null = rowEl
    ? {
        path:
          rowEl.getAttribute("data-entry-path") ??
          "",
        isDir:
          rowEl.getAttribute("data-entry-dir") ===
          "true",
        name: "",
        size: 0
      }
    : null;

  return resolveDropTarget({
    from,
    pane,
    entry,
    panePath:
      paneEl.getAttribute("data-pane-path") ?? ""
  });
}
