import { describe, it, expect } from "vitest";
import {
  checkKey,
  evaluateSample,
  inQuietHours,
  isDue,
  parseClock,
  pendingBreaches,
  type WatchEvent,
  type WatchStateMap
} from "@/watch/lib/watchRules";
import {
  makeCheck,
  type WatchConfig,
  type WatchSample
} from "@/watch/lib/watchTypes";

/**
 * 告警状态机。
 *
 * 这一组断言对应值守最容易出的三类事故：
 * - **误报**：抖一下就报 → 用户三天后静音通知；
 * - **刷屏**：同一条越界每拍都报 → 一晚上几百条；
 * - **装死**：连不上机器却什么都不说，比误报更危险。
 */

const T0 = 1_700_000_000_000;

/** 造一个只有 CPU/内存/磁盘/负载的采样。 */
function sample(
  patch: Partial<WatchSample> = {}
): WatchSample {
  return {
    at: T0,
    ok: true,
    cpu: 10,
    mem: 20,
    load: 0.2,
    cores: 4,
    disks: { "/": 40, "/data": 40 },
    services: { nginx: "active" },
    commandOutput: "",
    commandExit: 0,
    raw: "raw",
    ...patch
  };
}

/** 只开一个 CPU 检查的配置。 */
function cpuConfig(
  consecutive = 3,
  threshold = 90
): WatchConfig {
  return {
    sessionId: "s1",
    enabled: true,
    intervalSec: 60,
    checks: [
      {
        ...makeCheck("cpu"),
        enabled: true,
        threshold,
        consecutive
      }
    ]
  };
}

const OPTIONS = { cooldownMs: 30 * 60_000 };

describe("连续次数", () => {
  it("越界次数不足不告警", () => {
    let state: WatchStateMap = {};
    const config = cpuConfig(3);
    for (let i = 0; i < 2; i += 1) {
      const result = evaluateSample(
        config,
        sample({ cpu: 95 }),
        state,
        T0 + i * 60_000,
        OPTIONS
      );
      state = result.state;
      expect(result.events).toHaveLength(0);
    }
  });

  it("第 N 次越界才出一条告警", () => {
    let state: WatchStateMap = {};
    const config = cpuConfig(3);
    const events = [];
    for (let i = 0; i < 3; i += 1) {
      const result = evaluateSample(
        config,
        sample({ cpu: 95 }),
        state,
        T0 + i * 60_000,
        OPTIONS
      );
      state = result.state;
      events.push(...result.events);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("alert");
    expect(events[0]?.repeat).toBe(false);
  });

  it("中间恢复一次会清零，重新攒", () => {
    const config = cpuConfig(3);
    let state: WatchStateMap = {};
    // 两次越界 → 一次正常 → 再两次越界，仍然不够
    const values = [95, 95, 10, 95, 95];
    let events = 0;
    values.forEach((cpu, index) => {
      const result = evaluateSample(
        config,
        sample({ cpu }),
        state,
        T0 + index * 60_000,
        OPTIONS
      );
      state = result.state;
      events += result.events.length;
    });
    expect(events).toBe(0);
  });
});

describe("告警去重与冷却", () => {
  /** 攒到首次告警，返回状态。 */
  function firstAlert(
    config = cpuConfig(1)
  ): WatchStateMap {
    const result = evaluateSample(
      config,
      sample({ cpu: 95 }),
      {},
      T0,
      OPTIONS
    );
    expect(result.events).toHaveLength(1);
    return result.state;
  }

  it("冷却期内继续越界不重复报", () => {
    const config = cpuConfig(1);
    let state = firstAlert(config);
    for (let i = 1; i <= 5; i += 1) {
      const result = evaluateSample(
        config,
        sample({ cpu: 95 }),
        state,
        T0 + i * 60_000,
        OPTIONS
      );
      state = result.state;
      expect(result.events).toHaveLength(0);
    }
  });

  it("冷却到期仍越界会再提醒一次，标 repeat", () => {
    const config = cpuConfig(1);
    const state = firstAlert(config);
    const result = evaluateSample(
      config,
      sample({ cpu: 95 }),
      state,
      T0 + 31 * 60_000,
      OPTIONS
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.repeat).toBe(true);
  });

  it("恢复只发一条，且状态复位", () => {
    const config = cpuConfig(1);
    let state = firstAlert(config);
    const recovered = evaluateSample(
      config,
      sample({ cpu: 10 }),
      state,
      T0 + 60_000,
      OPTIONS
    );
    state = recovered.state;
    expect(recovered.events).toHaveLength(1);
    expect(recovered.events[0]?.level).toBe(
      "recover"
    );
    expect(state["s1:cpu:"]?.alerted).toBe(false);
    // 再正常一次不该重复发恢复
    const again = evaluateSample(
      config,
      sample({ cpu: 10 }),
      state,
      T0 + 120_000,
      OPTIONS
    );
    expect(again.events).toHaveLength(0);
  });
});

describe("取不到值时不误判", () => {
  it("值为 null 时状态原样保留（不清零也不累加）", () => {
    const config: WatchConfig = {
      sessionId: "s1",
      enabled: true,
      intervalSec: 60,
      checks: [
        {
          ...makeCheck("service"),
          enabled: true,
          unit: "ghost"
        }
      ]
    };
    const result = evaluateSample(
      config,
      sample(),
      {},
      T0,
      OPTIONS
    );
    expect(result.events).toHaveLength(0);
    // 连状态项都不该建出来
    expect(result.state).toEqual({});
  });

  it("停用的检查项不参与判定", () => {
    const config = cpuConfig(1);
    config.checks[0]!.enabled = false;
    const result = evaluateSample(
      config,
      sample({ cpu: 99 }),
      {},
      T0,
      OPTIONS
    );
    expect(result.events).toHaveLength(0);
  });
});

describe("连不上机器", () => {
  const config = cpuConfig(1);

  it("连一次不报，连第二次才报", () => {
    const first = evaluateSample(
      config,
      sample({ ok: false, error: "连接超时" }),
      {},
      T0,
      OPTIONS
    );
    expect(first.events).toHaveLength(0);
    const second = evaluateSample(
      config,
      sample({ ok: false, error: "连接超时" }),
      first.state,
      T0 + 60_000,
      OPTIONS
    );
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.kind).toBe(
      "connect"
    );
  });

  it("连不上时不判指标（不会同时报 CPU 高）", () => {
    const result = evaluateSample(
      config,
      sample({ ok: false, cpu: 99 }),
      {},
      T0,
      OPTIONS
    );
    expect(
      result.events.some(
        event => event.kind === "cpu"
      )
    ).toBe(false);
  });
});

describe("多个同类检查项互不干扰", () => {
  it("两个磁盘各有各的 streak", () => {
    const config: WatchConfig = {
      sessionId: "s1",
      enabled: true,
      intervalSec: 60,
      checks: [
        {
          ...makeCheck("disk"),
          enabled: true,
          mount: "/",
          threshold: 85,
          consecutive: 2
        },
        {
          ...makeCheck("disk"),
          enabled: true,
          mount: "/data",
          threshold: 85,
          consecutive: 2
        }
      ]
    };
    let state: WatchStateMap = {};
    // / 一直越界；/data 在中间短暂回落一次
    const samples = [
      { "/": 90, "/data": 90 },
      { "/": 90, "/data": 10 },
      { "/": 90, "/data": 90 }
    ];
    const events: WatchEvent[] = [];
    samples.forEach((disks, index) => {
      const result = evaluateSample(
        config,
        sample({ disks }),
        state,
        T0 + index * 60_000,
        OPTIONS
      );
      state = result.state;
      events.push(...result.events);
    });
    // 只有 / 攒满两次并告警
    expect(events).toHaveLength(1);
    expect(events[0]?.subject).toBe("/");
  });
});

describe("免打扰时段", () => {
  it("跨零点区间按「或」判断", () => {
    const quiet = {
      start: "23:00",
      end: "08:00"
    };
    expect(
      inQuietHours(
        new Date("2026-01-01T23:30:00"),
        quiet
      )
    ).toBe(true);
    expect(
      inQuietHours(
        new Date("2026-01-01T03:00:00"),
        quiet
      )
    ).toBe(true);
    expect(
      inQuietHours(
        new Date("2026-01-01T12:00:00"),
        quiet
      )
    ).toBe(false);
  });

  it("同日区间按「与」判断，端点左闭右开", () => {
    const quiet = {
      start: "09:00",
      end: "18:00"
    };
    expect(
      inQuietHours(
        new Date("2026-01-01T09:00:00"),
        quiet
      )
    ).toBe(true);
    expect(
      inQuietHours(
        new Date("2026-01-01T18:00:00"),
        quiet
      )
    ).toBe(false);
  });

  it("留空 / 非法一律视为不启用", () => {
    expect(
      inQuietHours(
        new Date("2026-01-01T03:00:00"),
        {
          start: "",
          end: ""
        }
      )
    ).toBe(false);
    expect(
      inQuietHours(
        new Date("2026-01-01T03:00:00"),
        {
          start: "25:00",
          end: "08:00"
        }
      )
    ).toBe(false);
    // 起点终点相同 = 空区间，不是「全天静音」
    expect(
      inQuietHours(
        new Date("2026-01-01T03:00:00"),
        {
          start: "08:00",
          end: "08:00"
        }
      )
    ).toBe(false);
  });

  it("时刻解析容错", () => {
    expect(parseClock("23:05")).toBe(1385);
    expect(parseClock(" 8:00 ")).toBe(480);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("ab")).toBeNull();
  });
});

describe("到期判断", () => {
  it("从未跑过一律到期", () => {
    expect(isDue(0, 60, T0, 30)).toBe(true);
  });

  it("不到间隔不跑；受下限保护", () => {
    expect(isDue(T0, 60, T0 + 30_000, 30)).toBe(
      false
    );
    expect(isDue(T0, 60, T0 + 60_000, 30)).toBe(
      true
    );
    // 配了 5 秒也按 30 秒下限算，避免把远端当压测靶
    expect(isDue(T0, 5, T0 + 10_000, 30)).toBe(
      false
    );
  });
});

describe("状态键", () => {
  it("同类不同对象不共用状态", () => {
    expect(checkKey("s1", "disk", "/")).not.toBe(
      checkKey("s1", "disk", "/data")
    );
  });
});

/**
 * 「观察中」：越界了但还没攒够连续次数。
 *
 * 面板靠它解释「阈值 5%、实测 42%，为什么没有告警」。这里同时钉住键的
 * 拼法 —— `pendingBreaches` 用 `checkKey` 去状态表里找，键一旦不一致
 * 就永远匹配不到，症状还是「不显示」，而且看不出错在哪。
 */
describe("观察中（越界但还没攒够次数）", () => {
  it("第一次越界给出 1/3", () => {
    const config = cpuConfig(3, 90);
    const { state } = evaluateSample(
      config,
      sample({ cpu: 95 }),
      {},
      T0,
      OPTIONS
    );
    const pending = pendingBreaches(
      config,
      state
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "cpu",
      count: 1,
      need: 3
    });
    expect(pending[0]?.value).toBeCloseTo(95, 5);
  });

  it("攒满并告警后不再算观察中", () => {
    const config = cpuConfig(3, 90);
    let state: WatchStateMap = {};
    for (let index = 0; index < 3; index += 1) {
      state = evaluateSample(
        config,
        sample({ cpu: 95 }),
        state,
        T0 + index * 60_000,
        OPTIONS
      ).state;
    }
    expect(
      pendingBreaches(config, state)
    ).toHaveLength(0);
  });

  it("没越界时为空", () => {
    const config = cpuConfig(3, 90);
    const { state } = evaluateSample(
      config,
      sample({ cpu: 10 }),
      {},
      T0,
      OPTIONS
    );
    expect(
      pendingBreaches(config, state)
    ).toHaveLength(0);
  });

  it("停用的检查项不出现", () => {
    const config = cpuConfig(3, 90);
    config.checks[0]!.enabled = false;
    const { state } = evaluateSample(
      config,
      sample({ cpu: 95 }),
      {},
      T0,
      OPTIONS
    );
    expect(
      pendingBreaches(config, state)
    ).toHaveLength(0);
  });

  it("取不到值的检查项不出现（没 systemd 不算观察中）", () => {
    const config: WatchConfig = {
      sessionId: "s1",
      enabled: true,
      intervalSec: 60,
      checks: [
        {
          ...makeCheck("service"),
          enabled: true,
          unit: "ghost"
        }
      ]
    };
    const { state } = evaluateSample(
      config,
      sample({ services: {} }),
      {},
      T0,
      OPTIONS
    );
    expect(
      pendingBreaches(config, state)
    ).toHaveLength(0);
  });
});
