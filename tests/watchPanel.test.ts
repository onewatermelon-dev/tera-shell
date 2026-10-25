import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 值守面板与走势图的静态渲染。
 *
 * 测试环境没有 DOM（见 AGENTS.md），所以用 `renderToStaticMarkup`：
 * 它抓不到交互，但能抓到**「一打开就白屏」**这类问题 —— 空数组导致的
 * 除零、缺字段的 `.toFixed`、把 undefined 当对象取属性，都会在渲染时炸。
 * 面板是「出事时才打开」的界面，真崩了用户只会以为值守没在跑。
 */

vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import WatchChart from "@/watch/components/WatchChart";
import WatchPanel from "@/watch/components/WatchPanel";
import type { PendingBreach } from "@/watch/lib/watchRules";
import type { useWatch } from "@/watch/lib/useWatch";
import type {
  WatchConfig,
  WatchPoint,
  WatchSample
} from "@/watch/lib/watchTypes";
import { defaultConfig } from "@/watch/lib/watchTypes";

const T0 = new Date(
  "2026-10-25T08:00:00"
).getTime();
const MIN = 60_000;

/** 三个点的走势（含一个空值，验证断线不炸）。 */
const POINTS: WatchPoint[] = [
  {
    at: T0,
    sessionId: "s1",
    cpu: 12,
    mem: 40,
    load: 0.3,
    disk: { mount: "/", pct: 61 }
  },
  {
    at: T0 + MIN,
    sessionId: "s1",
    cpu: null,
    mem: 42,
    load: 0.4,
    disk: { mount: "/", pct: 62 }
  },
  {
    at: T0 + 2 * MIN,
    sessionId: "s1",
    cpu: 78,
    mem: 45,
    load: 0.6,
    disk: { mount: "/", pct: 63 }
  }
];

/** 一条状态齐全的假采样。 */
const SAMPLE: WatchSample = {
  at: T0 + 2 * MIN,
  ok: true,
  cpu: 78,
  mem: 45,
  load: 0.6,
  cores: 4,
  disks: { "/": 63, "/data": 30 },
  services: { nginx: "active" },
  commandOutput: "",
  commandExit: 0,
  raw: ""
};

function configOf(
  sessionId: string
): WatchConfig {
  return {
    ...defaultConfig(sessionId),
    enabled: true
  };
}

/** 构造一个够用的 useWatch 返回值（只实现面板真正读到的部分）。 */
function fakeWatch(options: {
  configs: WatchConfig[];
  series?: WatchPoint[];
  sample?: WatchSample | null;
  breaching?: string[];
  pending?: PendingBreach[];
}) {
  const series = options.series ?? POINTS;
  return {
    configs: options.configs,
    alerts: [],
    series,
    statusOf: () => ({
      sample: options.sample ?? null,
      lastRunAt: 0,
      running: false,
      breaching: options.breaching ?? [],
      pending: options.pending ?? []
    }),
    pointsIn: (
      sessionId: string,
      from: number,
      to: number
    ) =>
      series.filter(
        point =>
          point.sessionId === sessionId &&
          point.at >= from &&
          point.at <= to
      ),
    runNow: async () => undefined,
    reload: () => undefined
  } as unknown as ReturnType<typeof useWatch>;
}

const SESSION = {
  id: "s1",
  name: "web-01",
  kind: "ssh" as const,
  host: "10.0.0.5",
  port: 22,
  username: "root"
};

describe("走势图", () => {
  it("有数据时画出两条折线并带阈值虚线", () => {
    const html = renderToStaticMarkup(
      createElement(WatchChart, {
        points: POINTS,
        threshold: 90
      })
    );
    expect(html).toContain("watch-chart-cpu");
    expect(html).toContain("watch-chart-mem");
    expect(html).toContain(
      "watch-chart-threshold"
    );
  });

  it("空序列不炸（刚开启巡检时的第一帧）", () => {
    const html = renderToStaticMarkup(
      createElement(WatchChart, { points: [] })
    );
    expect(html).toContain("watch-chart");
    expect(html).not.toContain(
      "watch-chart-threshold"
    );
  });

  it("没有阈值时不画虚线", () => {
    const html = renderToStaticMarkup(
      createElement(WatchChart, {
        points: POINTS
      })
    );
    expect(html).not.toContain(
      "watch-chart-threshold"
    );
  });
});

describe("值守面板", () => {
  it("没有启用配置时给出引导文案", () => {
    const html = renderToStaticMarkup(
      createElement(WatchPanel, {
        sessions: [SESSION],
        watch: fakeWatch({ configs: [] }),
        onClose: () => undefined,
        onConfigure: () => undefined,
        onAskAi: () => true,
        onError: () => undefined
      })
    );
    expect(html).toContain("watch.panel.empty");
  });

  it("有配置时列出机器、指标与阈值摘要", () => {
    const html = renderToStaticMarkup(
      createElement(WatchPanel, {
        sessions: [SESSION],
        watch: fakeWatch({
          configs: [configOf("s1")],
          sample: SAMPLE
        }),
        onClose: () => undefined,
        onConfigure: () => undefined,
        onAskAi: () => true,
        onError: () => undefined
      })
    );
    expect(html).toContain("web-01");
    expect(html).toContain("root@10.0.0.5");
    // CPU 78% —— 指标块渲染的是取整后的百分比
    expect(html).toContain("78%");
    // 最忙的盘是 /（63%）而不是 /data（30%）
    expect(html).toContain("/");
  });

  it("从未采样时不显示 undefined / NaN", () => {
    const html = renderToStaticMarkup(
      createElement(WatchPanel, {
        sessions: [SESSION],
        watch: fakeWatch({
          configs: [configOf("s1")],
          sample: null
        }),
        onClose: () => undefined,
        onConfigure: () => undefined,
        onAskAi: () => true,
        onError: () => undefined
      })
    );
    expect(html).toContain(
      "watch.panel.noSample"
    );
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined%");
  });

  it("会话已删除的配置被跳过（不会渲染空白行）", () => {
    const html = renderToStaticMarkup(
      createElement(WatchPanel, {
        sessions: [SESSION],
        // 配置指向一个不存在的会话
        watch: fakeWatch({
          configs: [configOf("ghost")]
        }),
        onClose: () => undefined,
        onConfigure: () => undefined,
        onAskAi: () => true,
        onError: () => undefined
      })
    );
    expect(html).toContain("watch.panel.empty");
  });
});

describe("观察中提示", () => {
  it("越界未满连续次数时显示 1/3（回答「为什么没告警」）", () => {
    const html = renderToStaticMarkup(
      createElement(WatchPanel, {
        sessions: [SESSION],
        watch: fakeWatch({
          configs: [configOf("s1")],
          sample: SAMPLE,
          pending: [
            {
              kind: "mem",
              subject: "mem",
              value: 42,
              count: 1,
              need: 3
            }
          ]
        }),
        onClose: () => undefined,
        onConfigure: () => undefined,
        onAskAi: () => true,
        onError: () => undefined
      })
    );
    expect(html).toContain("watch.panel.pending");
    // 42% 与 1/3 都要露出来
    expect(html).toContain("42%");
    expect(html).toContain("1/3");
  });
});
