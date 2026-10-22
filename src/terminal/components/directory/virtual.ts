/**
 * 目录栏的虚拟滚动：只渲染视口内（外加上下缓冲）的行。
 *
 * 为什么不引第三方：这里只有「等高行 + 纵向滚动」一种场景，定高算法
 * 二十行就够，不必为它增加一个依赖和一套 API。窗口化的关键是**行高
 * 必须固定** —— 行高与样式里的 `height` 是同一份约定（见
 * `_directory-panel.scss` 的 `.directory-row`），改一处就要改另一处。
 */

/** 单行高度（px），必须与样式里的 `.directory-row { height }` 一致。 */
export const ROW_HEIGHT = 26;

/** 视口上下各多渲染几行：快速滚动时不至于露白。 */
export const OVERSCAN = 8;

/**
 * 算出当前该渲染的行区间（左闭右开）。
 *
 * @param scrollTop 滚动容器已滚过的距离
 * @param viewportHeight 滚动容器的可视高度（不含 padding）
 * @param count 总行数
 * @param rowHeight 行高
 * @param overscan 上下缓冲行数
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  count: number,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0)
    return { start: 0, end: 0 };
  // 弹性滚动时 scrollTop 可能是负数
  const safeTop = Math.max(0, scrollTop);
  const first = Math.floor(safeTop / rowHeight);
  // 用 ceil 且至少 1 行：视口还没测出来（0）时也要先渲染一批，
  // 否则首帧空白
  const visible = Math.max(
    1,
    Math.ceil(viewportHeight / rowHeight)
  );
  const start = Math.max(0, first - overscan);
  const end = Math.min(
    count,
    first + visible + overscan
  );
  return { start, end };
}
