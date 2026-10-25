/**
 * 班报（Markdown）。
 *
 * 产物是**能直接粘进工单/群聊的纯文本**，不是屏幕专用组件：交班这条
 * 链路上，班报多半要发给别人 —— 一张只能在本机看的图，价值远不如一段
 * 能贴走的文字。所以图表留在界面上，导出走 Markdown。
 *
 * 与 `runbookLibrary.buildStepsMarkdown` 同一套路数：先一句总结，再表格，
 * 最后明细。刻意在结尾写明「本报告未调用 AI」，避免读者以为结论是模型
 * 生成的、或者反过来要求它「再分析一下」。
 */

import { KIND_LABEL } from "@/watch/lib/watchRules";
import type { ShiftStats } from "@/watch/lib/watchStats";
import { verdictOf } from "@/watch/lib/watchStats";

/** 一台会话的班报条目。 */
export type ReportEntry = {
  sessionName: string;
  host: string;
  stats: ShiftStats;
};

/** 生成班报。 */
export function buildShiftReport(input: {
  from: number;
  to: number;
  entries: ReportEntry[];
}): string {
  const breached = input.entries.filter(
    entry => entry.stats.breachCount > 0
  );
  const totalBreach = input.entries.reduce(
    (sum, entry) => sum + entry.stats.breachCount,
    0
  );
  const samples = input.entries.reduce(
    (sum, entry) => sum + entry.stats.samples,
    0
  );
  const lines = [
    `# 值守班报 · ${fmtClock(input.from)} ~ ${fmtClock(input.to)}`,
    "",
    `- 巡检会话：${input.entries.length} 台`,
    `- 越界：${totalBreach} 次${breached.length ? `（${breached.length} 台）` : ""}`,
    `- 采样：${samples} 点`,
    "",
    "## 一句结论",
    ""
  ];
  for (const entry of input.entries)
    lines.push(
      `- ${verdictOf(entry.stats, entry.sessionName)}`
    );

  lines.push(
    "",
    "## 明细",
    "",
    "| 会话 | 采样 | CPU 均值/峰值 | 内存均值/峰值 | 最忙磁盘 | 越界 |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const entry of input.entries) {
    const { stats, sessionName, host } = entry;
    lines.push(
      `| ${sessionName}（${host}） | ${stats.samples} | ${pair(stats.cpu)} | ${pair(stats.mem)} | ${diskCell(stats)} | ${stats.breachCount} |`
    );
  }

  const alerts = input.entries
    .flatMap(entry =>
      entry.stats.alerts.map(record => ({
        record,
        sessionName: entry.sessionName
      }))
    )
    .sort(
      (left, right) =>
        left.record.at - right.record.at
    );

  if (alerts.length > 0) {
    lines.push(
      "",
      "## 告警明细",
      "",
      "| 时间 | 会话 | 对象 | 数值 | 状态 |",
      "| --- | --- | --- | --- | --- |"
    );
    for (const {
      record,
      sessionName
    } of alerts) {
      lines.push(
        `| ${fmtClock(record.at)} | ${sessionName} | ${record.subject || KIND_LABEL[record.kind]} | ${
          record.level === "recover"
            ? "-"
            : `${fmtNumber(record.kind, record.value)} / 阈值 ${fmtNumber(record.kind, record.threshold)}`
        } | ${record.level === "alert" ? "告警" : "已恢复"} |`
      );
    }
  }

  lines.push(
    "",
    "---",
    "",
    "本报告由值守巡检的只读采样统计生成，**未调用 AI**。需要归因时，在告警记录上点「让 AI 归因」。"
  );
  return lines.join("\n");
}

/** 均值/峰值单元格；无数据时给「—」。 */
function pair(stat: ShiftStats["cpu"]): string {
  if (!stat || stat.count === 0) return "—";
  return `${Math.round(stat.avg)}% / ${Math.round(stat.max)}%`;
}

/** 磁盘单元格：挂载点 + 均值，带涨跌。 */
function diskCell(stats: ShiftStats): string {
  if (!stats.disk) return "—";
  const trend =
    stats.disk.delta >= 1
      ? ` ↑${stats.disk.delta.toFixed(1)}`
      : stats.disk.delta <= -1
        ? ` ↓${Math.abs(stats.disk.delta).toFixed(1)}`
        : "";
  return `${stats.disk.mount} ${Math.round(stats.disk.avg)}%${trend}`;
}

/** 数值格式：负载两位小数，其余取整。 */
function fmtNumber(
  kind: string,
  value: number
): string {
  if (kind === "load") return value.toFixed(2);
  if (kind === "service" || kind === "command")
    return value ? "通过" : "未通过";
  return `${Math.round(value)}%`;
}

/** 只要时分（面板行内用）：16:55。 */
export function fmtTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) =>
    String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 「10-25 08:00」；跨年场景不追求精确，班报本来就看当期。 */
export function fmtClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) =>
    String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
