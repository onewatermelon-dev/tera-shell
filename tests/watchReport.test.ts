import { describe, it, expect } from "vitest";
import {
  buildShiftReport,
  fmtClock,
  type ReportEntry
} from "@/watch/lib/watchReport";
import { summarize } from "@/watch/lib/watchStats";
import type {
  WatchAlertRecord,
  WatchPoint
} from "@/watch/lib/watchTypes";

/**
 * 班报 Markdown。
 *
 * 产物是要发给别人的文本，断言看的是「关键结论有没有落到纸上」：
 * 越界次数、告警明细、以及**未调用 AI** 这句声明 —— 少了它，
 * 收到班报的人会以为结论是模型给的，或者反过来要求它再分析一次。
 */

const T0 = new Date(
  "2026-10-25T08:00:00"
).getTime();
const MIN = 60_000;

function point(
  minutes: number,
  cpu: number,
  sessionId = "s1"
): WatchPoint {
  return {
    at: T0 + minutes * MIN,
    sessionId,
    cpu,
    mem: 40,
    load: 0.5,
    disk: { mount: "/", pct: 60 }
  };
}

function alert(
  minutes: number,
  level: "alert" | "recover"
): WatchAlertRecord {
  return {
    id: `${minutes}`,
    sessionId: "s1",
    sessionName: "web-01",
    kind: "disk",
    level,
    value: level === "alert" ? 91 : 62,
    threshold: 85,
    subject: "/",
    at: T0 + minutes * MIN,
    detail: "raw"
  };
}

function entryOf(
  points: WatchPoint[],
  alerts: WatchAlertRecord[]
): ReportEntry {
  return {
    sessionName: "web-01",
    host: "10.0.0.5",
    stats: summarize(
      points,
      alerts,
      "s1",
      T0,
      T0 + 600 * MIN
    )
  };
}

describe("班报正文", () => {
  it("有标题、汇总与明细表", () => {
    const report = buildShiftReport({
      from: T0,
      to: T0 + 600 * MIN,
      entries: [
        entryOf([point(0, 10), point(60, 20)], [])
      ]
    });
    expect(report).toContain("# 值守班报");
    expect(report).toContain("- 巡检会话：1 台");
    expect(report).toContain("## 一句结论");
    expect(report).toContain("## 明细");
    expect(report).toContain(
      "| web-01（10.0.0.5） |"
    );
  });

  it("有告警时列出明细表与状态", () => {
    const report = buildShiftReport({
      from: T0,
      to: T0 + 600 * MIN,
      entries: [
        entryOf(
          [point(0, 95)],
          [alert(1, "alert"), alert(2, "recover")]
        )
      ]
    });
    expect(report).toContain("## 告警明细");
    expect(report).toContain("| 告警 |");
    expect(report).toContain("| 已恢复 |");
    expect(report).toContain("阈值 85%");
  });

  it("无告警时不出现告警明细小节", () => {
    const report = buildShiftReport({
      from: T0,
      to: T0 + 600 * MIN,
      entries: [entryOf([point(0, 10)], [])]
    });
    expect(report).not.toContain("## 告警明细");
  });

  it("结尾声明未调用 AI（读者据此知道结论不是模型给的）", () => {
    const report = buildShiftReport({
      from: T0,
      to: T0 + 60 * MIN,
      entries: [entryOf([point(0, 10)], [])]
    });
    expect(report).toContain("未调用 AI");
  });

  it("多台机器各自一行，越界台数单独标注", () => {
    const second: ReportEntry = {
      sessionName: "db-01",
      host: "10.0.0.6",
      stats: summarize(
        [point(0, 10, "s2")],
        [],
        "s2",
        T0,
        T0 + 600 * MIN
      )
    };
    const report = buildShiftReport({
      from: T0,
      to: T0 + 600 * MIN,
      entries: [
        entryOf(
          [point(0, 95)],
          [alert(1, "alert")]
        ),
        second
      ]
    });
    expect(report).toContain("巡检会话：2 台");
    expect(report).toContain(
      "越界：1 次（1 台）"
    );
  });
});

describe("时间格式", () => {
  it("补零到分钟", () => {
    expect(
      fmtClock(
        new Date("2026-10-05T09:07:00").getTime()
      )
    ).toBe("10-05 09:07");
  });
});
