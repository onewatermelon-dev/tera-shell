import { describe, it, expect } from "vitest";
import {
  downsample,
  summarize,
  verdictOf
} from "@/watch/lib/watchStats";
import type {
  WatchAlertRecord,
  WatchPoint
} from "@/watch/lib/watchTypes";

/**
 * 班报的统计与结论。
 *
 * 这里的错误不会报错，只会**悄悄地给出一个看起来合理的数字** ——
 * 把 null 当 0 算平均、把多块盘混在一起算、越界次数算上恢复事件，
 * 结果都能正常渲染、也都像是真的。所以每条规则都钉一个断言。
 */

const T0 = new Date(
  "2026-10-25T08:00:00"
).getTime();
const MIN = 60_000;

/** 造一个采样点。 */
function point(
  minutes: number,
  cpu: number | null,
  mem: number | null = 40,
  disk: { mount: string; pct: number } | null = {
    mount: "/",
    pct: 50
  }
): WatchPoint {
  return {
    at: T0 + minutes * MIN,
    sessionId: "s1",
    cpu,
    mem,
    load: 0.5,
    disk
  };
}

/** 造一条告警。 */
function alert(
  minutes: number,
  level: "alert" | "recover",
  subject = "/"
): WatchAlertRecord {
  return {
    id: `${minutes}-${level}`,
    sessionId: "s1",
    sessionName: "web-01",
    kind: "disk",
    level,
    value: level === "alert" ? 90 : 40,
    threshold: 85,
    subject,
    at: T0 + minutes * MIN,
    detail: ""
  };
}

describe("指标统计", () => {
  it("均值/峰值/峰值时刻都对", () => {
    const stats = summarize(
      [point(0, 10), point(1, 50), point(2, 30)],
      [],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    expect(stats.samples).toBe(3);
    expect(stats.cpu?.avg).toBeCloseTo(30, 5);
    expect(stats.cpu?.max).toBe(50);
    expect(stats.cpu?.maxAt).toBe(T0 + MIN);
    expect(stats.cpu?.min).toBe(10);
  });

  it("null 不参与平均（当 0 会把均值算成本来没有的低值）", () => {
    const stats = summarize(
      [
        point(0, 60),
        point(1, null),
        point(2, 80)
      ],
      [],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    // (60+80)/2 = 70，而不是 (60+0+80)/3 = 46.7
    expect(stats.cpu?.avg).toBeCloseTo(70, 5);
    expect(stats.cpu?.count).toBe(2);
    // 采样点数仍然是 3：它统计的是「窗口内有多少个点」
    expect(stats.samples).toBe(3);
  });

  it("整段没有该指标时返回 null 而不是 0", () => {
    const stats = summarize(
      [point(0, null), point(1, null)],
      [],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    expect(stats.cpu).toBeNull();
  });

  it("磁盘只算出现最多的那块，并给出涨跌", () => {
    const stats = summarize(
      [
        point(0, 10, 40, { mount: "/", pct: 50 }),
        point(1, 10, 40, {
          mount: "/data",
          pct: 95
        }),
        point(2, 10, 40, { mount: "/", pct: 56 })
      ],
      [],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    // / 出现两次 → 选它；(50+56)/2=53，涨 6 个点
    expect(stats.disk?.mount).toBe("/");
    expect(stats.disk?.avg).toBeCloseTo(53, 5);
    expect(stats.disk?.delta).toBeCloseTo(6, 5);
  });

  it("时间窗外的点与告警都不计入", () => {
    const stats = summarize(
      [point(0, 10), point(100, 99)],
      [alert(0, "alert"), alert(200, "alert")],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    expect(stats.samples).toBe(1);
    expect(stats.breachCount).toBe(1);
  });

  it("越界次数只算 alert，不把恢复算进去", () => {
    const stats = summarize(
      [point(0, 10)],
      [alert(1, "alert"), alert(2, "recover")],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    expect(stats.alerts).toHaveLength(2);
    expect(stats.breachCount).toBe(1);
  });

  it("别的会话的告警不算在自己头上", () => {
    const foreign = {
      ...alert(1, "alert"),
      sessionId: "s2"
    };
    const stats = summarize(
      [point(0, 10)],
      [foreign],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    expect(stats.breachCount).toBe(0);
  });
});

describe("降采样", () => {
  it("点数超过上限时按桶压缩，且桶内保留峰值", () => {
    const points = Array.from(
      { length: 10 },
      (_, index) =>
        point(index, index === 4 ? 99 : 10)
    );
    const out = downsample(points, 5);
    expect(out).toHaveLength(5);
    // 峰值不能被平均抹掉
    expect(
      Math.max(...out.map(item => item.cpu ?? 0))
    ).toBe(99);
    // 时间取桶内最后一个，图上的 x 才不整体左移
    expect(out[out.length - 1]?.at).toBe(
      points[points.length - 1]?.at
    );
  });

  it("点数不超上限时原样返回", () => {
    const points = [point(0, 1), point(1, 2)];
    expect(downsample(points, 5)).toBe(points);
  });
});

describe("一句结论", () => {
  it("没有采样时直说没采到", () => {
    const stats = summarize(
      [],
      [],
      "s1",
      T0,
      T0 + MIN
    );
    expect(verdictOf(stats, "web-01")).toContain(
      "没有采到"
    );
  });

  it("有越界时先说越界几次、哪几项", () => {
    const stats = summarize(
      [point(0, 95), point(1, 96)],
      [alert(1, "alert", "/data")],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    const text = verdictOf(stats, "web-01");
    expect(text).toContain("1 次越界");
    expect(text).toContain("磁盘 /data");
  });

  it("无越界但峰值高时会点出短时高负载", () => {
    const stats = summarize(
      [point(0, 10), point(1, 88)],
      [],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    expect(verdictOf(stats, "web-01")).toContain(
      "短时高负载"
    );
  });

  it("平稳时给均值与峰值", () => {
    const stats = summarize(
      [point(0, 10), point(1, 20)],
      [],
      "s1",
      T0,
      T0 + 10 * MIN
    );
    const text = verdictOf(stats, "web-01");
    expect(text).toContain("运行平稳");
    expect(text).toContain("CPU 均值 15%");
  });
});
