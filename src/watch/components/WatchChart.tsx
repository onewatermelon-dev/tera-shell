import { fmtClock } from "@/watch/lib/watchReport";
import type { WatchPoint } from "@/watch/lib/watchTypes";

/**
 * 班报里的指标走势图（CPU / 内存两条折线 + 阈值虚线）。
 *
 * ## 为什么手写 SVG 而不是引图表库
 *
 * 这里要的只是「两条线 + 一条虚线阈值」，Chart.js / Recharts 会带进
 * 上百 KB 依赖和一整套主题适配（还得跟 HeroUI 的 CSS 变量对齐）。
 * 项目里已经有 `sparkline` 这类轻量画法的先例，保持一致更好维护。
 *
 * ## 为什么用 `preserveAspectRatio="none"` + `non-scaling-stroke`
 *
 * 面板宽度固定但窗口可能缩放，直接给固定 viewBox 会让线随宽度变粗变细。
 * 非等比拉伸 + 非缩放描边，等于「坐标按比例压缩、线宽始终 1.5px」，
 * 这也是 sparkline 的常用做法。缺数据的时段**断开**而不连线 ——
 * 连上去会让人以为「那段时间是平稳的」，实际是没采到。
 */
export default function WatchChart({
  points,
  threshold
}: {
  /** 时间正序的采样点（见 `pointsIn`） */
  points: WatchPoint[];
  /** 阈值虚线（0–100 的百分比指标才画） */
  threshold?: number;
}) {
  const width = 380;
  const height = 110;
  const toX = (index: number) =>
    points.length <= 1
      ? width / 2
      : (index / (points.length - 1)) * width;
  const toY = (value: number) =>
    height -
    (Math.min(100, Math.max(0, value)) / 100) *
      height;

  const line = (
    pick: (point: WatchPoint) => number | null
  ): string => {
    let path = "";
    let drawing = false;
    points.forEach((point, index) => {
      const value = pick(point);
      if (value === null) {
        // 断开：下一段重新 M
        drawing = false;
        return;
      }
      const command = drawing ? "L" : "M";
      path += `${command}${toX(index).toFixed(1)} ${toY(value).toFixed(1)} `;
      drawing = true;
    });
    return path.trim();
  };

  const cpuPath = line(point => point.cpu);
  const memPath = line(point => point.mem);
  const first = points[0]?.at;
  const last = points[points.length - 1]?.at;

  return (
    <div className="watch-chart">
      <div
        className="watch-chart-ylabels"
        aria-hidden="true"
      >
        <span>100</span>
        <span>50</span>
        <span>0</span>
      </div>
      <svg
        className="watch-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="CPU 与内存走势"
      >
        {/* 网格：只画 50% 一条，三条太吵 */}
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          className="watch-chart-grid"
          vectorEffect="non-scaling-stroke"
        />
        {threshold !== undefined &&
          threshold > 0 &&
          threshold <= 100 && (
            <line
              x1={0}
              y1={toY(threshold)}
              x2={width}
              y2={toY(threshold)}
              className="watch-chart-threshold"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="4 3"
            />
          )}
        {memPath && (
          <path
            d={memPath}
            className="watch-chart-mem"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {cpuPath && (
          <path
            d={cpuPath}
            className="watch-chart-cpu"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="watch-chart-xlabels">
        <span>
          {first ? fmtClock(first) : ""}
        </span>
        <span>{last ? fmtClock(last) : ""}</span>
      </div>
    </div>
  );
}
