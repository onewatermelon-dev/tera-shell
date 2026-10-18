import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import {
  MAX_CHART_POINTS,
  buildChartGeometry,
  formatTick,
  parseMetricChart
} from "@/terminal/lib/ai/metricChart";

const sample = {
  title: "CPU 使用率",
  unit: "%",
  type: "line",
  points: [
    { label: "10:00", value: 40 },
    { label: "10:05", value: 60 },
    { label: "10:10", value: 50 }
  ]
};

describe("图表数据解析", () => {
  it("完整数据", () => {
    const spec = parseMetricChart(
      JSON.stringify(sample)
    );
    expect(spec).toEqual({
      title: "CPU 使用率",
      unit: "%",
      type: "line",
      points: sample.points
    });
  });

  it("缺省字段有兜底：无标题/单位/type → 默认值", () => {
    const spec = parseMetricChart(
      JSON.stringify({
        points: [{ label: "a", value: 1 }]
      })
    );
    expect(spec?.title).toBe("");
    expect(spec?.unit).toBe("");
    expect(spec?.type).toBe("line");
  });

  it("type=bar 生效，其它值回落 line", () => {
    expect(
      parseMetricChart(
        JSON.stringify({ ...sample, type: "bar" })
      )?.type
    ).toBe("bar");
    expect(
      parseMetricChart(
        JSON.stringify({ ...sample, type: "pie" })
      )?.type
    ).toBe("line");
  });

  it("坏 JSON / 没有 points / 全是非法值 → null（回落代码块）", () => {
    expect(
      parseMetricChart("{ 还没写完")
    ).toBeNull();
    expect(
      parseMetricChart(
        JSON.stringify({ title: "x" })
      )
    ).toBeNull();
    expect(
      parseMetricChart(
        JSON.stringify({
          points: [{ label: "a", value: "高" }]
        })
      )
    ).toBeNull();
    expect(parseMetricChart("")).toBeNull();
    expect(parseMetricChart("[]")).toBeNull();
  });

  it("非数字点被丢弃，其余照画", () => {
    const spec = parseMetricChart(
      JSON.stringify({
        points: [
          { label: "a", value: 1 },
          { label: "b", value: null },
          { label: "c", value: "x" },
          { label: "d", value: 4 }
        ]
      })
    );
    expect(spec?.points).toHaveLength(2);
    expect(
      spec?.points.map(point => point.value)
    ).toEqual([1, 4]);
  });

  it("超过上限按等间隔抽稀，首尾都保留", () => {
    const points = Array.from(
      { length: 200 },
      (_item, index) => ({
        label: String(index),
        value: index
      })
    );
    const spec = parseMetricChart(
      JSON.stringify({ points })
    );
    expect(spec?.points).toHaveLength(
      MAX_CHART_POINTS
    );
    expect(spec?.points[0]?.value).toBe(0);
    expect(
      spec?.points[spec.points.length - 1]?.value
    ).toBe(199);
  });

  it("超长标题/标签被截断（防止撑破布局）", () => {
    const spec = parseMetricChart(
      JSON.stringify({
        title: "x".repeat(200),
        points: [
          { label: "y".repeat(200), value: 1 }
        ]
      })
    );
    expect(spec?.title.length).toBe(80);
    expect(spec?.points[0]?.label.length).toBe(
      24
    );
  });
});

describe("折线几何", () => {
  const box = { width: 400, height: 160 };

  it("点数与点坐标数量一致，X 递增", () => {
    const geo = buildChartGeometry(
      sample.points,
      box
    );
    expect(geo.dots).toHaveLength(3);
    expect(geo.dots[0]!.x).toBeLessThan(
      geo.dots[1]!.x
    );
    expect(geo.dots[1]!.x).toBeLessThan(
      geo.dots[2]!.x
    );
    // 值越大 Y 越小（SVG 原点在左上）
    expect(geo.dots[1]!.y).toBeLessThan(
      geo.dots[0]!.y
    );
  });

  it("path 以 M 起头、后续为 L，段数 = 点数-1", () => {
    const geo = buildChartGeometry(
      sample.points,
      box
    );
    expect(geo.linePath.startsWith("M")).toBe(
      true
    );
    expect(
      geo.linePath.match(/L/g) ?? []
    ).toHaveLength(2);
  });

  it("面积路径闭合（Z 结尾）", () => {
    const geo = buildChartGeometry(
      sample.points,
      box
    );
    expect(geo.areaPath.endsWith("Z")).toBe(true);
  });

  it("单点：居中且不画面积", () => {
    const geo = buildChartGeometry(
      [{ label: "now", value: 5 }],
      box
    );
    expect(geo.dots[0]!.x).toBeCloseTo(
      (400 + 38 - 10) / 2,
      0
    );
    expect(geo.areaPath).toBe("");
  });

  it("全 0 数据不炸（max 给兜底）", () => {
    const geo = buildChartGeometry(
      [
        { label: "a", value: 0 },
        { label: "b", value: 0 }
      ],
      box
    );
    expect(
      geo.dots.every(dot =>
        Number.isFinite(dot.y)
      )
    ).toBe(true);
  });

  it("负值落在零轴下方（Y 越小越靠上）", () => {
    const geo = buildChartGeometry(
      [
        { label: "a", value: -10 },
        { label: "b", value: 10 }
      ],
      box
    );
    // 负值点的 Y 更大 = 更靠下
    expect(geo.dots[0]!.y).toBeGreaterThan(
      geo.dots[1]!.y
    );
    // 刻度范围覆盖负数
    expect(geo.yTicks[0]!.value).toBeLessThan(0);
  });

  it("Y 轴 4 个刻度，覆盖 [min,max] 且单调", () => {
    const geo = buildChartGeometry(
      sample.points,
      box
    );
    expect(geo.yTicks).toHaveLength(4);
    const values = geo.yTicks.map(
      tick => tick.value
    );
    expect(values).toEqual(
      [...values].sort((a, b) => a - b)
    );
    expect(values[0]).toBe(0);
    expect(values[3]).toBeGreaterThanOrEqual(60);
  });

  it("X 标签抽稀：20 个点最多 7 个标签（末点必留）", () => {
    const points = Array.from(
      { length: 20 },
      (_item, index) => ({
        label: `t${index}`,
        value: index
      })
    );
    const geo = buildChartGeometry(points, box);
    expect(
      geo.xLabels.length
    ).toBeLessThanOrEqual(7);
    expect(geo.xLabels.at(-1)?.label).toBe("t19");
  });
});

describe("柱状几何", () => {
  const box = { width: 400, height: 160 };

  it("每个点一根柱，宽度不超过 28", () => {
    const geo = buildChartGeometry(
      sample.points,
      box
    );
    expect(geo.bars).toHaveLength(3);
    for (const bar of geo.bars)
      expect(bar.width).toBeLessThanOrEqual(28);
  });

  it("0 值也留 1px 高（否则看起来像数据缺失）", () => {
    const geo = buildChartGeometry(
      [{ label: "a", value: 0 }],
      box
    );
    expect(geo.bars[0]!.height).toBe(1);
  });

  it("柱子从零轴向上生长", () => {
    const geo = buildChartGeometry(
      [
        { label: "a", value: 10 },
        { label: "b", value: 20 }
      ],
      box
    );
    // 高度按值排序
    expect(geo.bars[1]!.height).toBeGreaterThan(
      geo.bars[0]!.height
    );
  });
});

describe("刻度文字", () => {
  it("整数不带小数点，小数保留一位", () => {
    expect(formatTick(0)).toBe("0");
    expect(formatTick(60)).toBe("60");
    expect(formatTick(1.25)).toBe("1.3");
  });
});

describe("渲染与接线", () => {
  it("图表组件渲染出 SVG（折线与柱状）", async () => {
    const { AiMetricChart } =
      await import("@/terminal/components/ai/AiMetricChart");
    const line = renderToStaticMarkup(
      createElement(AiMetricChart, {
        spec: {
          ...sample,
          type: "line" as const
        }
      })
    );
    expect(line).toContain("<svg");
    expect(line).toContain("<path");
    expect(line).toContain("CPU 使用率");
    // 末尾的关键数值
    expect(line).toContain("最新 50");

    const bar = renderToStaticMarkup(
      createElement(AiMetricChart, {
        spec: {
          ...sample,
          type: "bar" as const
        }
      })
    );
    expect(bar).toContain("<rect");
  }, 60_000);

  it("markdown 渲染层拦截 metric-chart 围栏块", async () => {
    const src = (
      await import("@/terminal/components/ai/AiMarkdown.tsx?raw")
    ).default;
    expect(src).toContain("metric-chart");
    expect(src).toContain("parseMetricChart");
    expect(src).toContain("AiMetricChart");
    // 解析失败要回落代码块，不能白屏
    expect(src).toContain("AiCodeBlock");
  });

  it("提示词要求监控数据画图、不要用表格", async () => {
    const { SYSTEM_PROMPT } =
      await import("@/terminal/lib/ai/promptContext");
    expect(SYSTEM_PROMPT).toContain(
      "metric-chart"
    );
    expect(SYSTEM_PROMPT).toContain(
      "不要用 markdown 表格"
    );
    expect(SYSTEM_PROMPT).toContain("points");
  });
});
