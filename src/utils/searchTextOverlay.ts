import type {
  IDecoration,
  IMarker,
  Terminal
} from "@xterm/xterm";

const overlays: Array<{
  decoration: IDecoration;
  marker: IMarker;
}> = [];

export interface SearchCell {
  getChars(): string;
  getWidth(): number;
}

/** 转义字面搜索文本中的正则特殊字符。 */
export function escapeSearchText(query: string) {
  return query.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/** 把 xterm 单元格组装成文本，并记录每个字符对应的实际网格列。 */
export function buildSearchRowMap(
  columnCount: number,
  getCell: (
    column: number
  ) => SearchCell | undefined
) {
  const columns: number[] = [];
  const widths: number[] = [];
  let text = "";

  for (
    let column = 0;
    column < columnCount;
    column++
  ) {
    const cell = getCell(column);
    const chars = cell?.getChars() ?? "";
    if (!chars) continue;
    for (
      let index = 0;
      index < chars.length;
      index++
    ) {
      columns[text.length + index] = column;
      widths[text.length + index] = Math.max(
        cell?.getWidth() ?? 1,
        1
      );
    }
    text += chars;
  }
  return { text, columns, widths };
}

/** 移除上一轮搜索创建的黑色文字覆盖层。 */
export function clearSearchTextOverlays() {
  overlays
    .splice(0)
    .forEach(({ decoration, marker }) => {
      // 必须先销毁装饰器 marker: xterm 6 的装饰表在删除条目时按 marker.line
      // 二分查找，marker 先销毁会让 line 变成 -1，导致旧条目删除失败而永久滞留，
      // 破坏表的有序性，使后续按行查找装饰随机落空（黄色高亮间歇性丢失）
      decoration.dispose();
      marker.dispose();
    });
}

/**
 * 清扫装饰服务里的“幽灵条目”
 *
 * xterm 6 的装饰表用惰性删除维护有序性：同一行多个条目在同一次同步批次里被销毁
 * 时，先前被销毁条目的 marker 已变为 line = -1，会阻断后续同 key 条目的二分查找，
 * 使其删除失败，永久滞留，滞留条目破坏表的有序性，导致渲染时按行查装饰随机落空
 * （黄色高亮间接性丢失），本函数在每次搜索动作结束后物理移除这些幽灵排序，
 * 使下一次渲染永远读到干净的表，依赖内部结构，因此版本锁定 ^6.0.0 切未升级前有效。
 * @param terminal
 */
export function sweepStaleDecorations(
  terminal: Terminal
) {
  const list = (
    terminal as unknown as {
      _core: {
        _decorationService: {
          _decorations: {
            _array: Array<{
              marker: { line: number };
            }>;
            _insertedValues: unknown[];
            _deletedIndices: unknown[];
            _flushCleanupInserted?: () => void;
          };
        };
      };
    }
  )._core._decorationService._decorations;
  list._flushCleanupInserted?.();
  const live = list._array
    .filter(d => d.marker.line !== -1)
    .sort(
      (a, b) => a.marker.line - b.marker.line
    );
  list._array.splice(
    0,
    list._array.length,
    ...live
  );
  list._deletedIndices.length = 0;
}

/**
 * 为搜索命中文字绘制黑色 DOM 覆盖层。
 *
 * 覆盖层不改变 xterm 画布内的原始前景色；搜索词变化时直接删除 DOM，
 * 因此不会出现最后一个单元格颜色无法恢复的问题。
 */
export function paintSearchTextOverlays(
  terminal: Terminal,
  query: string,
  regex: boolean,
  caseSensitive: boolean
) {
  clearSearchTextOverlays();
  if (!query) return;

  const flags = caseSensitive ? "g" : "gi";
  const escaped = escapeSearchText(query);
  const pattern = new RegExp(
    regex ? query : escaped,
    flags
  );
  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const { text, columns, widths } =
      buildSearchRowMap(line.length, column =>
        line.getCell(column)
      );
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text))) {
      if (!match[0]) {
        pattern.lastIndex++;
        continue;
      }
      addOverlay(
        terminal,
        row,
        cursorRow,
        columns[match.index] ?? 0,
        match[0],
        getMatchWidth(
          match.index,
          match[0].length,
          columns,
          widths
        )
      );
    }
    pattern.lastIndex = 0;
  }
}

/** 把字符区间换算成 xterm 网格列宽，正确覆盖中文等宽字符。 */
function getMatchWidth(
  start: number,
  length: number,
  columns: number[],
  widths: number[]
) {
  const startColumn = columns[start] ?? 0;
  const last = start + length - 1;
  return Math.max(
    1,
    (columns[last] ?? startColumn) +
      (widths[last] ?? 1) -
      startColumn
  );
}

/** 在指定缓冲区位置注册一个与搜索背景重合的黑色文字层。 */
function addOverlay(
  terminal: Terminal,
  row: number,
  cursorRow: number,
  column: number,
  text: string,
  width: number
) {
  const marker = terminal.registerMarker(
    row - cursorRow
  );
  const decoration = terminal.registerDecoration({
    marker,
    x: column,
    width
  });
  if (!decoration) {
    marker.dispose();
    return;
  }

  decoration.onRender(element => {
    element.textContent = text;
    element.style.color = "#000000";
    element.style.fontFamily = String(
      terminal.options.fontFamily
    );
    element.style.fontSize = `${terminal.options.fontSize}px`;
    element.style.whiteSpace = "pre";
    element.style.overflow = "hidden";
    element.style.pointerEvents = "none";
  });
  overlays.push({ decoration, marker });
}
