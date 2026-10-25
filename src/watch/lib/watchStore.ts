/**
 * 值守配置与告警历史的存取（`watch.json`）。
 *
 * ## 为什么单独一个数据文件，而不是塞进 sessions.json
 *
 * 会话要导出/导入（`sessionTransfer.ts` 会序列化指定字段），巡检配置带
 * 端口、单元名和命令，属于「这台机器怎么盯」的运行策略，不该跟着
 * 会话文件到处跑 —— 导到别人机器上再按别人的阈值告警就麻烦了。
 *
 * ## 读的时候一律做清洗
 *
 * 这个文件是纯文本、可手改。用户填了 `intervalSec: 0`、`threshold: "abc"`、
 * 甚至把 `checks` 删掉，都不该让巡检整个崩掉 —— 清洗后的默认值比抛错
 * 更有用（最坏情况是「按默认值盯着」，而不是「什么都不盯还一声不响」）。
 */

import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import { logWarn } from "@/shared/lib/log";
import {
  ALERT_HISTORY_LIMIT,
  CHECK_DEFAULTS,
  DEFAULT_COOLDOWN_MIN,
  DEFAULT_WATCH_INTERVAL_SEC,
  MIN_WATCH_INTERVAL_SEC,
  SERIES_PER_SESSION,
  SERIES_TOTAL_LIMIT,
  emptyWatchFile,
  type QuietHours,
  type WatchAlertRecord,
  type WatchCheck,
  type WatchCheckKind,
  type WatchConfig,
  type WatchFile,
  type WatchPoint
} from "@/watch/lib/watchTypes";

/** 合法的检查项类型（清洗时用）。 */
const KINDS: WatchCheckKind[] = [
  "cpu",
  "mem",
  "disk",
  "load",
  "service",
  "command"
];

/** 读整份配置；文件缺失/损坏时返回空配置。 */
export function loadWatchFile(): WatchFile {
  const raw = readData(DataName.watch);
  if (!raw) return emptyWatchFile();
  try {
    const parsed = JSON.parse(
      raw
    ) as Partial<WatchFile>;
    return {
      configs: Array.isArray(parsed.configs)
        ? parsed.configs
            .map(sanitizeConfig)
            .filter(
              (item): item is WatchConfig =>
                item !== null
            )
        : [],
      quiet: sanitizeQuiet(parsed.quiet),
      cooldownMin: clampNumber(
        parsed.cooldownMin,
        1,
        24 * 60,
        DEFAULT_COOLDOWN_MIN
      ),
      alerts: Array.isArray(parsed.alerts)
        ? parsed.alerts
            .map(sanitizeAlert)
            .filter(
              (item): item is WatchAlertRecord =>
                item !== null
            )
            .slice(0, ALERT_HISTORY_LIMIT)
        : [],
      series: Array.isArray(parsed.series)
        ? parsed.series
            .map(sanitizePoint)
            .filter(
              (item): item is WatchPoint =>
                item !== null
            )
            .slice(0, SERIES_TOTAL_LIMIT)
        : []
    };
  } catch (reason) {
    logWarn(
      "[watch] 值守配置解析失败，按空配置继续",
      reason
    );
    return emptyWatchFile();
  }
}

/** 写整份配置。 */
export function saveWatchFile(
  file: WatchFile
): void {
  writeData(DataName.watch, JSON.stringify(file));
}

/** 取某个会话的配置（没有则返回 undefined）。 */
export function configOf(
  file: WatchFile,
  sessionId: string
): WatchConfig | undefined {
  return file.configs.find(
    item => item.sessionId === sessionId
  );
}

/** 写入/更新一个会话的配置，返回新文件对象。 */
export function upsertConfig(
  file: WatchFile,
  config: WatchConfig
): WatchFile {
  const rest = file.configs.filter(
    item => item.sessionId !== config.sessionId
  );
  return {
    ...file,
    configs: [
      ...rest,
      sanitizeConfig(config) ?? config
    ]
  };
}

/** 删除某个会话的配置，返回新文件对象。 */
export function removeConfig(
  file: WatchFile,
  sessionId: string
): WatchFile {
  return {
    ...file,
    configs: file.configs.filter(
      item => item.sessionId !== sessionId
    )
  };
}

/**
 * 追加告警记录（新的在前，超限截断）。
 *
 * 历史只用于「事后归因」与面板展示，不需要无限增长 —— 200 条足够覆盖
 * 一次通宵值守，再多就是囤日志了（日志本来就在 tracing 里）。
 */
export function appendAlerts(
  file: WatchFile,
  records: WatchAlertRecord[]
): WatchFile {
  if (records.length === 0) return file;
  return {
    ...file,
    alerts: [...records, ...file.alerts].slice(
      0,
      ALERT_HISTORY_LIMIT
    )
  };
}

/**
 * 追加采样点（新的在前），并按会话/总量双重截断。
 *
 * 双限是必要的：单会话限长保证「一台机器 12 小时可回溯」，总量限长保证
 * 「三十台机器不会把文件写到几十 MB」——只限其中一个，另一头总会失控。
 */
export function appendPoints(
  file: WatchFile,
  points: WatchPoint[]
): WatchFile {
  if (points.length === 0) return file;
  const counts = new Map<string, number>();
  const kept: WatchPoint[] = [];
  for (const point of [
    ...points,
    ...file.series
  ]) {
    const used = counts.get(point.sessionId) ?? 0;
    if (used >= SERIES_PER_SESSION) continue;
    counts.set(point.sessionId, used + 1);
    kept.push(point);
    if (kept.length >= SERIES_TOTAL_LIMIT) break;
  }
  return { ...file, series: kept };
}

/**
 * 从序列里取某个会话在时间窗内的采样点（**按时间正序**，画图用）。
 *
 * `series` 存的是新在前（便于截断），而折线要从左往右画 —— 这个反转
 * 只在这里做一次，图表组件不必关心存储顺序。
 */
export function pointsOf(
  series: WatchPoint[],
  sessionId: string,
  from: number,
  to: number
): WatchPoint[] {
  const out: WatchPoint[] = [];
  for (const point of series) {
    if (point.sessionId !== sessionId) continue;
    if (point.at < from || point.at > to)
      continue;
    out.push(point);
  }
  return out.reverse();
}

/** 清洗一个采样点；时间或会话缺失时丢弃。 */
function sanitizePoint(
  value: unknown
): WatchPoint | null {
  const raw = (value ??
    {}) as Partial<WatchPoint>;
  const at = Number(raw.at);
  const sessionId = String(
    raw.sessionId ?? ""
  ).trim();
  if (
    !Number.isFinite(at) ||
    at <= 0 ||
    !sessionId
  )
    return null;
  const nullable = (input: unknown) =>
    typeof input === "number" &&
    Number.isFinite(input)
      ? input
      : null;
  const disk = raw.disk as
    | { mount?: string; pct?: number }
    | null
    | undefined;
  return {
    at,
    sessionId,
    cpu: nullable(raw.cpu),
    mem: nullable(raw.mem),
    load: nullable(raw.load),
    disk:
      disk?.mount && Number.isFinite(disk.pct)
        ? {
            mount: String(disk.mount),
            pct: Number(disk.pct)
          }
        : null
  };
}

/** 数值夹取，非法值退回默认。 */
function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 清洗免打扰时段："23:00" 这类；非法一律清空（= 不启用）。 */
function sanitizeQuiet(
  value: unknown
): QuietHours {
  const raw = (value ??
    {}) as Partial<QuietHours>;
  const clock = (text: unknown) =>
    /^(\d{1,2}):(\d{2})$/.test(
      String(text ?? "").trim()
    )
      ? String(text).trim()
      : "";
  const start = clock(raw.start);
  const end = clock(raw.end);
  // 只有一端填了等于没填：半开区间无从判断，直接当作关闭
  return start && end
    ? { start, end }
    : { start: "", end: "" };
}

/** 清洗单个检查项；类型不认识时返回 null（整项丢弃）。 */
function sanitizeCheck(
  value: unknown
): WatchCheck | null {
  const raw = (value ??
    {}) as Partial<WatchCheck>;
  const kind = String(
    raw.kind ?? ""
  ) as WatchCheckKind;
  if (!KINDS.includes(kind)) return null;
  const defaults = CHECK_DEFAULTS[kind];
  return {
    kind,
    enabled: raw.enabled === true,
    // 阈值上限给了 10000：负载/自定义指标可能用不到百分比，
    // 但没必要为此分歧出第二套字段
    threshold: clampNumber(
      raw.threshold,
      0,
      10000,
      defaults.threshold
    ),
    consecutive: Math.round(
      clampNumber(
        raw.consecutive,
        1,
        60,
        defaults.consecutive
      )
    ),
    mount:
      kind === "disk"
        ? String(raw.mount ?? "/").trim() || "/"
        : undefined,
    unit:
      kind === "service"
        ? String(raw.unit ?? "").trim()
        : undefined,
    command:
      kind === "command"
        ? String(raw.command ?? "").trim()
        : undefined,
    expect:
      kind === "command"
        ? String(raw.expect ?? "").trim()
        : undefined
  };
}

/** 清洗一个会话的配置。 */
function sanitizeConfig(
  value: unknown
): WatchConfig | null {
  const raw = (value ??
    {}) as Partial<WatchConfig>;
  const sessionId = String(
    raw.sessionId ?? ""
  ).trim();
  // 没有 sessionId 的配置条等于孤儿：既跑不了也无法在界面上关掉
  if (!sessionId) return null;
  const checks = Array.isArray(raw.checks)
    ? raw.checks
        .map(sanitizeCheck)
        .filter(
          (item): item is WatchCheck =>
            item !== null
        )
    : [];
  return {
    sessionId,
    enabled: raw.enabled === true,
    intervalSec: Math.round(
      clampNumber(
        raw.intervalSec,
        MIN_WATCH_INTERVAL_SEC,
        3600,
        DEFAULT_WATCH_INTERVAL_SEC
      )
    ),
    checks
  };
}

/** 清洗一条告警历史。 */
function sanitizeAlert(
  value: unknown
): WatchAlertRecord | null {
  const raw = (value ??
    {}) as Partial<WatchAlertRecord>;
  if (!raw.id || !raw.sessionId) return null;
  return {
    id: String(raw.id),
    sessionId: String(raw.sessionId),
    sessionName: String(raw.sessionName ?? ""),
    kind: (raw.kind ??
      "cpu") as WatchAlertRecord["kind"],
    level:
      raw.level === "recover"
        ? "recover"
        : "alert",
    value: Number(raw.value) || 0,
    threshold: Number(raw.threshold) || 0,
    subject: String(raw.subject ?? ""),
    at: Number(raw.at) || 0,
    detail: String(raw.detail ?? "").slice(
      0,
      2000
    )
  };
}
