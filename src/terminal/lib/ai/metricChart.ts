/**
 * 指标图表：把监控数据画成图，而不是让它以 markdown 表格的形式躺在
 * 正文里。
 *
 * ## 为什么用围栏块而不是工具调用
 *
 * 模型已经有了 run_command 这类工具，但「画图」不需要执行任何东西，
 * 它只是**输出格式**的选择。用 ```metric-chart 围栏块描述数据：
 *
 * - 改动面小：渲染层拦一下语言标识即可，不用动三家协议的工具 schema；
 * - 流式友好：数据边生成边累积，闭合后自动从代码块变成图；
 * - 可回退：JSON 坏了（或没写完）就按普通代码块显示，不会白屏。
 *
 * ## 数据格式（模型按提示词输出）
 *
 * ```metric-chart
 * { "title": "CPU 使用率", "unit": "%", "type": "line",
 *   "points": [{ "label": "10:00", "value": 42 }] }
 * ```
 *
 * 几何计算抽成纯函数：node 环境没有 DOM，靠它做单测。
 */

/** 一个数据点。 */
export type ChartPoint = {
  label: string;
  value: number;
};

/** 解析后的图表规格。 */
export type MetricChartSpec = {
  title: string;
  unit: string;
  type: "line" | "bar";
  points: ChartPoint[];
};

/**
 * 点数上限：防止模型把几千个采样点塞进来。
 *
 * 超了按「等间隔抽稀」保留首尾与中间趋势，不要直接截断
 * （直接截断会把后半段的趋势整段丢掉）。
 */
export const MAX_CHART_POINTS = 60;

/** 图表的坐标布局（SVG viewBox 坐标系，单位任意）。 */
export type ChartGeometry = {
  linePath: string;
  areaPath: string;
  bars: {
    x: number;
    y: number;
    width: number;
    height: number;
    value: number;
    label: string;
  }[];
  dots: {
    x: number;
    y: number;
    value: number;
    label: string;
  }[];
  yTicks: { y: number; value: number }[];
  xLabels: { x: number; label: string }[];
};

/** 绘图区留白：左侧给 Y 轴刻度文字，底部给 X 轴标签。 */
const PAD = {
  top: 10,
  right: 10,
  bottom: 20,
  left: 38
};

/**
 * 解析 ```metric-chart 的内容。
 *
 * 解析失败一律返回 null，由渲染层回退成普通代码块 —— 流式期间 JSON
 * 还没闭合时必然走到这条路，不能抛错。
 */
export function parseMetricChart(
  raw: string
): MetricChartSpec | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object")
    return null;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.points)) return null;

  const points: ChartPoint[] = [];
  for (const item of obj.points) {
    if (!item || typeof item !== "object")
      continue;
    const point = item as Record<string, unknown>;
    const raw = point.value;
    // ⚠️ 只收 number / 数字字符串：`Number(null)` 是 0、`Number(true)`
    // 是 1 —— 直接 Number() 会把空值画成 0，图上凭空多一个假点
    if (
      typeof raw !== "number" &&
      typeof raw !== "string"
    )
      continue;
    const value =
      typeof raw === "number"
        ? raw
        : Number(raw.trim());
    if (
      !Number.isFinite(value) ||
      (typeof raw === "string" &&
        raw.trim() === "")
    )
      continue;
    points.push({
      label: String(point.label ?? "").slice(
        0,
        24
      ),
      value
    });
  }
  if (points.length === 0) return null;

  return {
    title:
      typeof obj.title === "string"
        ? obj.title.slice(0, 80)
        : "",
    unit:
      typeof obj.unit === "string"
        ? obj.unit.slice(0, 12)
        : "",
    type: obj.type === "bar" ? "bar" : "line",
    points: thin(points, MAX_CHART_POINTS)
  };
}

/** 等间隔抽稀：始终保留首尾点（趋势的边界）。 */
function thin(
  points: ChartPoint[],
  limit: number
): ChartPoint[] {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  const out: ChartPoint[] = [];
  for (let i = 0; i < limit; i += 1)
    out.push(points[Math.round(i * step)]!);
  return out;
}

/** 刻度文字：整数不带小数点，其余一位小数。 */
function tickText(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1);
}

/**
 * 计算折线/柱状的几何路径。
 *
 * 纯函数：给定点与画布尺寸，产出 SVG 能直接用的坐标。测试直接断言
 * 这里的数值，不需要 DOM。
 */
export function buildChartGeometry(
  points: ChartPoint[],
  box: { width: number; height: number }
): ChartGeometry {
  const plotW = Math.max(
    1,
    box.width - PAD.left - PAD.right
  );
  const plotH = Math.max(
    1,
    box.height - PAD.top - PAD.bottom
  );
  const values = points.map(point => point.value);
  const rawMax = Math.max(...values, 0);
  const rawMin = Math.min(...values, 0);
  // 顶部留 8% 余量，避免最高点贴着边框；全 0 时给个 1 兜底
  const yMax = rawMax > 0 ? rawMax * 1.08 : 1;
  const yMin = rawMin < 0 ? rawMin * 1.08 : 0;
  const span = yMax - yMin || 1;

  const xOf = (index: number) =>
    points.length === 1
      ? PAD.left + plotW / 2
      : PAD.left +
        (index / (points.length - 1)) * plotW;
  const yOf = (value: number) =>
    PAD.top + ((yMax - value) / span) * plotH;
  const zeroY = yOf(0);

  const dots = points.map((point, index) => ({
    x: xOf(index),
    y: yOf(point.value),
    value: point.value,
    label: point.label
  }));

  const linePath = dots
    .map(
      (dot, index) =>
        `${index === 0 ? "M" : "L"}${dot.x.toFixed(
          1
        )},${dot.y.toFixed(1)}`
    )
    .join(" ");
  // 面积：折线首尾接到零轴（柱状图不用）
  const areaPath =
    dots.length > 1
      ? `${linePath} L${dots[
          dots.length - 1
        ]!.x.toFixed(1)},${zeroY.toFixed(
          1
        )} L${dots[0]!.x.toFixed(1)},${zeroY.toFixed(
          1
        )} Z`
      : "";

  const barWidth = Math.min(
    28,
    (plotW / Math.max(1, points.length)) * 0.6
  );
  const bars = dots.map(dot => {
    const y = dot.value >= 0 ? dot.y : zeroY;
    const height = Math.abs(dot.y - zeroY);
    return {
      x: dot.x - barWidth / 2,
      y,
      width: barWidth,
      // 0 值给 1px：否则柱子在视觉上不存在，用户会以为数据缺失
      height: height < 1 ? 1 : height,
      value: dot.value,
      label: dot.label
    };
  });

  const yTicks = [0, 1, 2, 3].map(index => {
    const value = yMin + (span * index) / 3;
    return { y: yOf(value), value };
  });

  // X 轴标签抽稀：最多 6 个，太多会叠在一起
  const labelStep = Math.max(
    1,
    Math.ceil(points.length / 6)
  );
  const xLabels = dots
    .map(dot => ({
      x: dot.x,
      label: dot.label
    }))
    .filter(
      (_item, index) =>
        index % labelStep === 0 ||
        index === points.length - 1
    );

  return {
    linePath,
    areaPath,
    bars,
    dots,
    yTicks,
    xLabels
  };
}

/** 刻度值给 UI 用（对外暴露，测试也断言它）。 */
export function formatTick(
  value: number
): string {
  return tickText(value);
}
