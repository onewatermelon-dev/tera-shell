/**
 * 事后归因：把一次越界的现场打包成「可以直接发给模型」的一段文本。
 *
 * ## 为什么只打包、不发送
 *
 * 值守每 60 秒采一次，一晚上上千次采样。任何一次顺手问模型，都是一笔
 * 没人同意的开销 —— 而绝大多数采样是正常的，根本没东西可问。
 *
 * 所以这里只做**准备**：命中的那一条 + 最近几条同会话告警 + 采样原文
 * （已截断），等用户点「让 AI 归因」时才走正常的对话通道。与
 * `terminal/lib/failureDiagnosis.ts` 是同一条纪律的两个方向。
 *
 * ## 为什么把「只读」写进提示词
 *
 * 归因现场最常见的要求是「告诉我该敲什么」。模型如果给出 `systemctl
 * restart`，用户很可能直接照着敲 —— 而这台机器正在告警状态，重启什么
 * 都可能让事情更糟。提示词里明确要求「先给判断依据，再给可选的处置
 * 建议，并标注风险」，让用户在动手前有一次思考的机会。
 */

import type { WatchEvent } from "@/watch/lib/watchRules";
import {
  KIND_LABEL,
  formatValue
} from "@/watch/lib/watchRules";
import type {
  WatchAlertRecord,
  WatchSample
} from "@/watch/lib/watchTypes";

/** 送进 AI 面板的正文上限（与 `ASK_TEXT_LIMIT` 对齐）。 */
const TEXT_LIMIT = 7500;

/** 最近 N 条同会话告警一起带上：孤立的单点数字说明不了趋势。 */
const RECENT_LIMIT = 6;

/**
 * 拼出归因正文。
 *
 * @param params.sessionName 会话名（模型靠它区分机器）
 * @param params.host 主机地址
 * @param params.event 本次触发的事件
 * @param params.sample 触发时的采样
 * @param params.recent 告警历史（按时间倒序，取同会话的前几条）
 */
export function buildWatchDiagnosisText(params: {
  sessionName: string;
  host: string;
  event: WatchEvent;
  sample: WatchSample;
  recent: WatchAlertRecord[];
}): string {
  const { event, sample } = params;
  const subject =
    event.kind === "connect"
      ? "连接"
      : KIND_LABEL[event.kind];
  const head = [
    `值守巡检在 ${params.sessionName}（${params.host}）上命中了「${subject}」这一项：`,
    event.level === "recover"
      ? `已经恢复，当前值 ${formatValue(event.kind, event.value)}。`
      : `当前值 ${formatValue(event.kind, event.value)}，阈值 ${formatValue(event.kind, event.threshold)}${event.kind === "disk" || event.kind === "service" || event.kind === "command" ? `（对象：${event.subject}）` : ""}。`,
    event.repeat
      ? "这条告警已经持续一段时间（这是重复提醒）。"
      : ""
  ]
    .filter(Boolean)
    .join("\n");

  const metrics = [
    "本次采样：",
    `- CPU 占用：${pct(sample.cpu)}`,
    `- 内存占用：${pct(sample.mem)}`,
    `- 每核负载：${sample.load === null ? "未知" : `${sample.load.toFixed(2)}（${sample.cores} 核）`}`,
    `- 磁盘：${
      Object.entries(sample.disks)
        .map(
          ([mount, pctValue]) =>
            `${mount} ${Math.round(pctValue)}%`
        )
        .join("，") || "未知"
    }`,
    `- 服务：${
      Object.entries(sample.services)
        .map(
          ([unit, state]) => `${unit}=${state}`
        )
        .join("，") || "未配置"
    }`
  ].join("\n");

  const history =
    params.recent.length > 0
      ? [
          "最近告警：",
          ...params.recent
            .slice(0, RECENT_LIMIT)
            .map(
              record =>
                `- ${new Date(record.at).toLocaleString()} ${record.level === "recover" ? "恢复" : "告警"} ${record.subject} ${record.kind === "service" ? "" : formatValue(record.kind, record.value)}`
            )
        ].join("\n")
      : "";

  const raw = sample.raw.trim()
    ? [
        "采样原文（截断）：",
        "```",
        sample.raw.trim(),
        "```"
      ].join("\n")
    : "";

  const tail =
    "请先判断最可能的原因（结合上面的指标与原文，指出依据）；" +
    "如果需要进一步确认，列出**只读**的排查命令；" +
    "最后再给处置建议，并注明风险。不要假设你已经执行过任何命令。";

  return [head, metrics, history, raw, tail]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, TEXT_LIMIT);
}

/** 百分比格式化；取不到时明确写「未知」而不是 0%。 */
function pct(value: number | null): string {
  return value === null
    ? "未知"
    : `${Math.round(value)}%`;
}

/**
 * 由**历史记录**拼一段归因文本。
 *
 * 与 `buildWatchDiagnosisText` 的差别：那条走的是「刚触发，采样还在内存里」；
 * 这条走的是「翻历史，采样只剩截断原文」。用户多半是在事后（早上起来看
 * 昨晚发生了什么）才想起问 AI，所以这条其实用得更多。
 */
export function buildRecordDiagnosis(
  record: WatchAlertRecord
): string {
  const subject =
    record.kind === "connect"
      ? "连接"
      : KIND_LABEL[record.kind];
  const head = [
    `值守巡检在 ${record.sessionName} 上记录了一条「${subject}」${record.level === "recover" ? "恢复" : "告警"}：`,
    record.level === "recover"
      ? "当时已恢复正常。"
      : `数值 ${formatValue(record.kind, record.value)}，阈值 ${formatValue(record.kind, record.threshold)}（对象：${record.subject}）。`,
    `时间：${new Date(record.at).toLocaleString()}`
  ].join("\n");
  const raw = record.detail.trim()
    ? [
        "采样原文（截断）：",
        "```",
        record.detail.trim(),
        "```"
      ].join("\n")
    : "";
  const tail =
    "请先判断最可能的原因并指出依据；需要进一步确认时列出**只读**排查命令；" +
    "最后给处置建议并注明风险。不要假设你已经执行过任何命令。";
  return [head, raw, tail]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, TEXT_LIMIT);
}
