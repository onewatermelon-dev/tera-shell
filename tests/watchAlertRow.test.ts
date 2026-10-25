import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 组件用 useT()；这里只关心按钮是否渲染，键名原样返回即可
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import WatchAlertRow, {
  describeAlert
} from "@/watch/components/WatchAlertRow";
import type { Translator } from "@/settings/lib/i18n";
import type { WatchAlertRecord } from "@/watch/lib/watchTypes";

/**
 * 告警行的「说人话」。
 *
 * 回归背景（2026-10-25）：列表直接渲染 `record.subject`，界面上出现
 * 「告警 mem」和「告警 /」两种看不懂的行 —— 前者是内部枚举漏出去，
 * 后者只有一个斜杠，既不知是磁盘也不知道用了多少。现在统一成
 * 「指标 [对象] 数值（阈值 x）」，这里逐项钉住。
 */

const LABELS: Record<string, string> = {
  "watch.kind.cpu": "CPU",
  "watch.kind.mem": "内存",
  "watch.kind.disk": "磁盘",
  "watch.kind.load": "负载",
  "watch.kind.service": "服务",
  "watch.kind.command": "自定义检查",
  "watch.kind.connect": "连接",
  "watch.recovered": "已恢复",
  "watch.alerted": "告警",
  "watch.metric.threshold": "阈值"
};

const t = ((key: string) =>
  LABELS[key] ?? key) as unknown as Translator;

function record(
  patch: Partial<WatchAlertRecord>
): WatchAlertRecord {
  return {
    id: "a",
    sessionId: "s1",
    sessionName: "web-01",
    kind: "mem",
    level: "alert",
    value: 42,
    threshold: 5,
    subject: "",
    at: 0,
    detail: "",
    ...patch
  };
}

describe("告警行说明", () => {
  it("百分比指标：指标 值（阈值 x）", () => {
    expect(describeAlert(record({}), t)).toBe(
      "内存 42%（阈值 5%）"
    );
  });

  it("根分区的斜杠不露出来（默认值）", () => {
    expect(
      describeAlert(
        record({
          kind: "disk",
          subject: "/",
          value: 91,
          threshold: 85
        }),
        t
      )
    ).toBe("磁盘 91%（阈值 85%）");
  });

  it("非根挂载点要标出来", () => {
    expect(
      describeAlert(
        record({
          kind: "disk",
          subject: "/data",
          value: 93,
          threshold: 85
        }),
        t
      )
    ).toBe("磁盘 /data 93%（阈值 85%）");
  });

  it("负载按两位小数，不带百分号", () => {
    expect(
      describeAlert(
        record({
          kind: "load",
          value: 2.437,
          threshold: 2
        }),
        t
      )
    ).toBe("负载 2.44（阈值 2.00）");
  });

  it("服务只说对象与状态（没有数值可看）", () => {
    expect(
      describeAlert(
        record({
          kind: "service",
          subject: "nginx",
          value: 0,
          threshold: 0
        }),
        t
      )
    ).toBe("服务 nginx · 告警");
  });

  it("恢复记录标出已恢复", () => {
    expect(
      describeAlert(
        record({ level: "recover", value: 3 }),
        t
      )
    ).toBe("内存 3% · 已恢复");
  });

  it("连不上机器：只给连接与原因", () => {
    expect(
      describeAlert(
        record({
          kind: "connect",
          subject: "连接超时",
          value: 0,
          threshold: 0
        }),
        t
      )
    ).toBe("连接：连接超时");
  });

  it("旧记录里 subject 存的是枚举时不会漏到界面", () => {
    const text = describeAlert(
      record({ subject: "mem" }),
      t
    );
    expect(text).toBe("内存 42%（阈值 5%）");
    expect(text).not.toContain("mem");
  });
});

describe("告警行渲染", () => {
  it("只有传了 onDelete 才出现删除按钮", () => {
    const withDelete = renderToStaticMarkup(
      createElement(WatchAlertRow, {
        record: record({}),
        onAskAi: () => undefined,
        onDelete: () => undefined
      })
    );
    expect(withDelete).toContain(
      "watch.alert.delete"
    );

    const without = renderToStaticMarkup(
      createElement(WatchAlertRow, {
        record: record({}),
        onAskAi: () => undefined
      })
    );
    expect(without).not.toContain(
      "watch.alert.delete"
    );
  });

  it("恢复记录没有归因按钮，但有删除按钮", () => {
    const html = renderToStaticMarkup(
      createElement(WatchAlertRow, {
        record: record({ level: "recover" }),
        onAskAi: () => undefined,
        onDelete: () => undefined
      })
    );
    expect(html).not.toContain("watch.askAi");
    expect(html).toContain("watch.alert.delete");
  });
});
