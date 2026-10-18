"use client";

/**
 * 指标图表卡片：渲染 ```metric-chart 围栏块里的监控数据。
 *
 * 纯 SVG（不引图表库）：只画折线/柱状 + 网格 + 刻度，几千字节就够，
 * 也省掉一个依赖。几何计算在 lib/ai/metricChart.ts（纯函数，可单测）。
 *
 * ⚠️ 宽度**实测**（ResizeObserver）而不是靠 viewBox 缩放：面板宽度
 * 只有 300-400px，若按 640 宽的 viewBox 等比缩，9px 的刻度字会缩到
 * 4-5px 看不清；1:1 绘制时字号就是真实像素。
 *
 * 颜色全走主题变量（--accent / --accent-soft / --border / --muted），
 * 明暗主题自动跟随。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  buildChartGeometry,
  formatTick,
  type MetricChartSpec
} from "@/terminal/lib/ai/metricChart";
import styles from "./AiMetricChart.module.css";

/** 图表高度（CSS 像素；宽度由容器实测决定）。 */
const CHART_HEIGHT = 160;
/** 没测到宽度前的初值：只影响首帧，下一帧就会被真实值替换。 */
const FALLBACK_WIDTH = 360;

export function AiMetricChart({
  spec
}: {
  spec: MetricChartSpec;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(
    FALLBACK_WIDTH
  );

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    // 面板可拖拽调宽 → 每次都按新宽度重算几何
    const observer = new ResizeObserver(
      entries => {
        const next = Math.round(
          entries[0]?.contentRect.width ?? 0
        );
        if (next > 0) setWidth(next);
      }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(
    () =>
      buildChartGeometry(spec.points, {
        width,
        height: CHART_HEIGHT
      }),
    [spec.points, width]
  );

  const values = spec.points.map(
    point => point.value
  );
  const latest =
    spec.points[spec.points.length - 1]?.value;
  const isBar = spec.type === "bar";

  return (
    <figure className={styles.card} ref={hostRef}>
      <figcaption className={styles.head}>
        <span className={styles.title}>
          {spec.title || "指标"}
        </span>
        {spec.unit && (
          <span className={styles.unit}>
            {spec.unit}
          </span>
        )}
      </figcaption>
      <svg
        className={styles.canvas}
        width={width}
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        role="img"
        aria-label={`${spec.title || "指标"} 图表，共 ${
          spec.points.length
        } 个数据点`}
      >
        {/* 网格线 + Y 轴刻度 */}
        {geometry.yTicks.map(tick => (
          <g key={`y-${tick.value}`}>
            <line
              className={styles.grid}
              x1={0}
              x2={width}
              y1={tick.y}
              y2={tick.y}
            />
            <text
              className={styles.tick}
              x={4}
              y={tick.y - 3}
            >
              {formatTick(tick.value)}
            </text>
          </g>
        ))}

        {isBar ? (
          geometry.bars.map(bar => (
            <rect
              key={`bar-${bar.label}-${bar.x}`}
              className={styles.bar}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx="2"
            >
              <title>{`${bar.label} ${bar.value}${spec.unit}`}</title>
            </rect>
          ))
        ) : (
          <>
            {geometry.areaPath && (
              <path
                className={styles.area}
                d={geometry.areaPath}
              />
            )}
            <path
              className={styles.line}
              d={geometry.linePath}
            />
            {geometry.dots.map(dot => (
              <circle
                key={`dot-${dot.label}-${dot.x}`}
                className={styles.dot}
                cx={dot.x}
                cy={dot.y}
                r="2.5"
              >
                <title>{`${dot.label} ${dot.value}${spec.unit}`}</title>
              </circle>
            ))}
          </>
        )}

        {/* X 轴标签 */}
        {geometry.xLabels.map(item => (
          <text
            key={`x-${item.label}-${item.x}`}
            className={styles.tick}
            x={item.x}
            y={CHART_HEIGHT - 6}
            textAnchor="middle"
          >
            {item.label}
          </text>
        ))}
      </svg>
      {/* 末尾给一行关键数值：光看趋势读不出具体数 */}
      <div className={styles.stats}>
        <span>
          最新 {latest ?? "-"}
          {spec.unit}
        </span>
        <span>
          最高 {Math.max(...values)}
          {spec.unit}
        </span>
        <span>
          最低 {Math.min(...values)}
          {spec.unit}
        </span>
      </div>
    </figure>
  );
}
