import type {
  IBufferLine,
  IBufferRange,
  Terminal
} from "@xterm/xterm";

/** 返回一行中最后一个可见字符之后的终端列下标。 */
function getTextEnd(
  line: IBufferLine,
  columns: number
) {
  for (
    let column =
      Math.min(line.length, columns) - 1;
    column >= 0;
    column--
  ) {
    const cell = line.getCell(column);
    if (cell?.getChars().trim()) {
      // 中文等宽字符可能占两列，必须把整个字符宽度包含在可见选区内。
      return (
        column + Math.max(cell.getWidth(), 1)
      );
    }
  }
  return 0;
}

/**
 * 使用按行覆盖层绘制“仅文字区域”的终端选区。
 *
 * xterm 原生选区是一个连续线性区间：跨行选择时，中间行必然高亮到终端最右侧，
 * 无法表达每一行不同的文字长度。因此终端主题会把原生选区背景设为透明，本函数
 * 再读取真实选区，为每个可见缓冲区行绘制一个只覆盖实际字符的矩形。
 *
 * 真实选区仍由 xterm 管理，所以复制、双击选词、滚动和键盘行为不会被重写；这里只
 * 替换视觉表现。选区、滚动、尺寸或终端内容变化时，都在下一动画帧统一重绘一次。
 *
 * @param terminal xterm 实例，提供真实选区和缓冲区内容。
 * @param container 承载该终端的 DOM 容器，xterm.open() 后内部会生成 .xterm-screen。
 */
export function renderTextOnlySelection(
  terminal: Terminal,
  container: HTMLElement
) {
  let frame: number | undefined;
  let dragStart:
    IBufferRange["start"] | undefined;
  let dragging = false;

  /** 获取或创建覆盖层；首次调用可能发生在 xterm.open() 之前，此时暂不创建。 */
  function getOverlay() {
    const screen =
      container.querySelector<HTMLElement>(
        ".xterm-screen"
      );
    if (!screen) return;
    let overlay =
      screen.querySelector<HTMLElement>(
        ":scope > .terminal-selection-overlay"
      );
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className =
        "terminal-selection-overlay";
      screen.append(overlay);
    }
    return { screen, overlay };
  }

  /** 按指定选区为每一个可见行创建独立矩形，行末填充单元格不会进入矩形。 */
  function draw(
    selection = terminal.getSelectionPosition()
  ) {
    frame = undefined;
    const target = getOverlay();
    if (!target) return;
    const { screen, overlay } = target;
    overlay.replaceChildren();

    if (
      !selection ||
      !screen.clientWidth ||
      !screen.clientHeight
    )
      return;

    const viewportStart =
      terminal.buffer.active.viewportY;
    const viewportEnd =
      viewportStart + terminal.rows - 1;
    const firstRow = Math.max(
      selection.start.y,
      viewportStart
    );
    const lastRow = Math.min(
      selection.end.y,
      viewportEnd
    );
    const cellWidth =
      screen.clientWidth / terminal.cols;
    const cellHeight =
      screen.clientHeight / terminal.rows;

    for (
      let row = firstRow;
      row <= lastRow;
      row++
    ) {
      const line =
        terminal.buffer.active.getLine(row);
      if (!line) continue;
      const textEnd = getTextEnd(
        line,
        terminal.cols
      );

      // 第一行从真实选区起点开始，中间行从第 0 列开始，最后一行止于真实终点。
      const startColumn =
        row === selection.start.y
          ? Math.min(selection.start.x, textEnd)
          : 0;
      const endColumn =
        row === selection.end.y
          ? Math.min(selection.end.x, textEnd)
          : textEnd;
      if (endColumn <= startColumn) continue;

      const range = document.createElement("div");
      range.className =
        "terminal-selection-range";
      range.style.left = `${startColumn * cellWidth}px`;
      range.style.top = `${(row - viewportStart) * cellHeight}px`;
      range.style.width = `${(endColumn - startColumn) * cellWidth}px`;
      range.style.height = `${cellHeight}px`;
      overlay.append(range);
    }
  }

  /** 合并同一帧中的多次变化，避免拖动或大量终端输出时重复操作 DOM。 */
  function scheduleDraw() {
    if (frame !== undefined) return;
    // 使用包装函数丢弃 requestAnimationFrame 传入的时间戳，draw 的参数是选区而非时间。
    frame = requestAnimationFrame(() => draw());
  }

  /** 取消可能尚未执行的帧合并任务，并立刻绘制给定选区。 */
  function drawImmediately(
    selection?: IBufferRange
  ) {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    draw(selection);
  }

  /** 将鼠标像素坐标直接转换成当前可见缓冲区的终端网格坐标。 */
  function locateMouse(
    event: MouseEvent
  ): IBufferRange["start"] | undefined {
    const screen =
      container.querySelector<HTMLElement>(
        ".xterm-screen"
      );
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    return {
      x: Math.max(
        0,
        Math.min(
          terminal.cols,
          Math.floor(
            ((event.clientX - rect.left) /
              rect.width) *
              terminal.cols
          )
        )
      ),
      y:
        terminal.buffer.active.viewportY +
        Math.max(
          0,
          Math.min(
            terminal.rows - 1,
            Math.floor(
              ((event.clientY - rect.top) /
                rect.height) *
                terminal.rows
            )
          )
        )
    };
  }

  /** 按文档顺序整理拖选起点和当前鼠标位置，支持从下往上、从右往左选择。 */
  function normalizeRange(
    anchor: IBufferRange["start"],
    pointer: IBufferRange["end"]
  ): IBufferRange {
    const pointerBeforeAnchor =
      pointer.y < anchor.y ||
      (pointer.y === anchor.y &&
        pointer.x < anchor.x);
    return pointerBeforeAnchor
      ? { start: pointer, end: anchor }
      : { start: anchor, end: pointer };
  }

  /**
   * 直接由原始 mousemove 驱动覆盖层，不等待 xterm 较晚触发的 onSelectionChange。
   * 浏览器处理完本次鼠标事件时，覆盖层已经具有当前指针对应的位置。
   */
  function handleMouseMove(event: MouseEvent) {
    if (!dragStart || (event.buttons & 1) === 0)
      return;
    const pointer = locateMouse(event);
    if (pointer)
      drawImmediately(
        normalizeRange(dragStart, pointer)
      );
  }

  /** 结束直接绘制，并在 xterm 完成本次 mouseup 后同步一次真实选区。 */
  function handleMouseUp() {
    dragging = false;
    dragStart = undefined;
    document.removeEventListener(
      "mousemove",
      handleMouseMove,
      true
    );
    document.removeEventListener(
      "mouseup",
      handleMouseUp,
      true
    );
    queueMicrotask(() => drawImmediately());
  }

  container.addEventListener(
    "mousedown",
    event => {
      if (event.button !== 0) return;
      dragStart = locateMouse(event);
      if (!dragStart) return;
      dragging = true;
      // 捕获阶段先于 xterm 注册在 document 冒泡阶段的选区处理器执行。
      document.addEventListener(
        "mousemove",
        handleMouseMove,
        true
      );
      document.addEventListener(
        "mouseup",
        handleMouseUp,
        true
      );
    },
    true
  );

  /**
   * 鼠标选区必须同步跟随指针，不能等待下一动画帧。
   * 如果之前有滚动或输出安排的延迟重绘，先取消它，避免同步绘制后又重复执行一次。
   */
  terminal.onSelectionChange(() => {
    // 拖动期间由原始 mousemove 直接绘制，忽略 xterm 延后的选区通知，避免视觉回退。
    if (dragging) return;
    drawImmediately();
  });

  // 滚动、尺寸和内容变化不直接由用户拖选驱动，可以继续按帧合并以减少 DOM 重绘。
  terminal.onScroll(scheduleDraw);
  terminal.onResize(scheduleDraw);
  terminal.onRender(scheduleDraw);
}
