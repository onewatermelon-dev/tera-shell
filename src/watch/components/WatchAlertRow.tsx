import { Button } from "@heroui/react";
import { DeleteOutlined } from "@ant-design/icons";
import {
  useT,
  type Translator
} from "@/settings/lib/i18n";
import { fmtTime } from "@/watch/lib/watchReport";
import type { WatchAlertRecord } from "@/watch/lib/watchTypes";

/**
 * 一条告警的行内说明（面板与配置弹窗共用）。
 *
 * ## 为什么要专门做一层「说人话」
 *
 * 之前列表直接渲染 `record.subject`，于是出现两种看不懂的行：
 * - `告警 mem` —— CPU/内存/负载没有「对象」，`subject` 里存的是内部枚举，
 *   原样漏到了界面上；
 * - `告警 /` —— 磁盘的对象确实是挂载点，但只有一个斜杠，看不出是磁盘、
 *   更看不出用了多少。
 *
 * 现在统一成「指标 [对象] 数值（阈值 x）」：读者不需要知道内部字段，
 * 一眼就知道**什么、多少、超过多少才算事**。
 */
export function describeAlert(
  record: WatchAlertRecord,
  t: Translator
): string {
  const label = t(`watch.kind.${record.kind}`);
  // CPU / 内存 / 负载的 subject 现在是空串；磁盘是挂载点、服务是单元名。
  // 两道过滤：
  // - `!== kind`：给**旧记录**兜底（改之前 subject 存的是 "mem" 这类枚举，
  //   直接拼出来就是「内存 mem 42%」）；
  // - `!== "/"`：根分区是默认值，「磁盘 / 12%」里那个斜杠会被读成多打的字符。
  const subject =
    record.subject &&
    record.subject !== record.kind &&
    record.subject !== "/"
      ? ` ${record.subject}`
      : "";
  if (record.kind === "connect")
    return `${label}：${record.subject}`;
  const level =
    record.level === "recover"
      ? t("watch.recovered")
      : t("watch.alerted");
  // 服务 / 自定义只看活着还是匹配上，没有可比的数值
  if (
    record.kind === "service" ||
    record.kind === "command"
  )
    return `${label}${subject} · ${level}`;
  // 负载是「每核负载」，不是百分比
  const format = (value: number) =>
    record.kind === "load"
      ? value.toFixed(2)
      : String(Math.round(value));
  const unit = record.kind === "load" ? "" : "%";
  const value = ` ${format(record.value)}${unit}`;
  // 恢复也带当前值：只说「已恢复」，读者不知道回到了多少
  return record.level === "recover"
    ? `${label}${subject}${value} · ${level}`
    : `${label}${subject}${value}（${t("watch.metric.threshold")} ${format(record.threshold)}${unit}）`;
}

/**
 * 一行告警：色点 + 时间 · 会话 · 说明 + 「让 AI 归因」。
 *
 * @param showSession 面板里要带会话名（同屏有多台），配置弹窗里不需要
 */
export default function WatchAlertRow({
  record,
  onAskAi,
  onDelete,
  showSession = true
}: {
  record: WatchAlertRecord;
  onAskAi: (record: WatchAlertRecord) => void;
  /** 不传 = 只读；面板与配置弹窗都传，共用同一份历史 */
  onDelete?: (record: WatchAlertRecord) => void;
  showSession?: boolean;
}) {
  const t = useT();
  return (
    <div
      className="watch-alert"
      data-level={record.level}
    >
      {/* 色点先于文字：扫一列时先分「红的还是灰的」，再看细节 */}
      <span
        className="watch-alert-dot"
        aria-hidden="true"
      />
      <span className="watch-alert-text">
        <span className="watch-alert-time">
          {fmtTime(record.at)}
        </span>
        {showSession
          ? ` · ${record.sessionName}`
          : ""}
        {" · "}
        {describeAlert(record, t)}
      </span>
      {/* 只有告警才值得归因：恢复记录交给 AI 只会换来一句「已经好了」 */}
      {record.level === "alert" && (
        <Button
          size="sm"
          variant="ghost"
          className="watch-alert-ai"
          onPress={() => onAskAi(record)}
        >
          {t("watch.askAi")}
        </Button>
      )}
      {onDelete && (
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          className="watch-alert-del"
          aria-label={t("watch.alert.delete")}
          onPress={() => onDelete(record)}
        >
          <DeleteOutlined />
        </Button>
      )}
    </div>
  );
}
