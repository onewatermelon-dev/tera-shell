import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  Button,
  Typography
} from "@heroui/react";
import {
  CloseOutlined,
  ReloadOutlined,
  SettingOutlined
} from "@ant-design/icons";
import type { SavedSession } from "@/sessions/lib/session";
import {
  useT,
  type Translator
} from "@/settings/lib/i18n";
import { logError } from "@/shared/lib/log";
import { loadPanelWidth } from "@/terminal/lib/ai/aiPrefs";
import WatchAlertRow from "@/watch/components/WatchAlertRow";
import WatchChart from "@/watch/components/WatchChart";
import { buildRecordDiagnosis } from "@/watch/lib/watchDiagnosis";
import {
  buildShiftReport,
  fmtTime
} from "@/watch/lib/watchReport";
import { formatValue } from "@/watch/lib/watchRules";
import {
  downsample,
  summarize,
  verdictOf
} from "@/watch/lib/watchStats";
import type { useWatch } from "@/watch/lib/useWatch";
import type {
  WatchAlertRecord,
  WatchConfig,
  WatchPoint,
  WatchSample
} from "@/watch/lib/watchTypes";

type Props = {
  /** 全部已保存会话（配了巡检但不存在的会被跳过） */
  sessions: SavedSession[];
  /** App 层的巡检实例（心跳、状态、采样序列都在它手里） */
  watch: ReturnType<typeof useWatch>;
  onClose: () => void;
  onConfigure: (session: SavedSession) => void;
  /**
   * 把归因文本送进 AI 面板。
   *
   * 由 App 注入而不是组件自己调 `askAiFromTerminal`：AI 面板挂在**当前
   * 活动终端**上，被巡检的会话未必开着 —— App 才有「必要时先开终端、
   * 等面板挂载后补发」的能力。返回 false 表示彻底发不出去。
   */
  onAskAi: (
    text: string,
    sessionId: string
  ) => boolean;
  onError: (message: string) => void;
};

/** 班报时间窗。 */
const RANGES = [
  { id: "shift", hours: 8 },
  { id: "day", hours: 24 }
] as const;

/**
 * 值守面板：**状态**与**班报**两个视角。
 *
 * ## 为什么两者放同一个抽屉
 *
 * 「现在有没有事」和「这一班发生过什么」是同一个问题的两个时态。
 * 分成两个入口，用户在交班时会先在告警列表里翻，再去找班报按钮；
 * 放一起就一步：进去 → 切 tab。
 *
 * ## 为什么状态与班报的数据源不同
 *
 * 状态读**内存里的最新采样**（`statusOf`，每次心跳后更新，秒级）；
 * 班报读**落盘的时序**（`pointsIn`，攒批写，最坏晚 5 分钟）。
 * 两者刻意不混：状态要即时，班报要完整 —— 混用会让状态跟着落盘节奏卡顿。
 */
export default function WatchPanel({
  sessions,
  watch,
  onClose,
  onConfigure,
  onAskAi,
  onError
}: Props) {
  const t = useT();
  const [tab, setTab] = useState<
    "status" | "report"
  >("status");
  const [range, setRange] = useState<
    "shift" | "day"
  >("shift");
  /**
   * 复制成功的提示。
   *
   * 不走右上角的错误气泡：那里会记一条 error 日志，而「复制成功」不是
   * 错误。面板内的行内提示更合适，也不会 5 秒后被别的事件顶掉。
   */
  const [hint, setHint] = useState("");

  /** 会话 id → 会话（配了巡检但会话已删的会被过滤掉）。 */
  const byId = useMemo(
    () =>
      new Map(
        sessions.map(session => [
          session.id,
          session
        ])
      ),
    [sessions]
  );

  /** 真正在跑的配置（会话还在、且不是本地会话）。 */
  const active = useMemo(
    () =>
      watch.configs
        .filter(config => config.enabled)
        .map(config => ({
          config,
          session: byId.get(config.sessionId)
        }))
        .filter(
          (
            item
          ): item is {
            config: WatchConfig;
            session: SavedSession;
          } =>
            Boolean(item.session) &&
            item.session?.kind !== "local"
        ),
    [watch.configs, byId]
  );

  const hours = RANGES.find(
    item => item.id === range
  )!.hours;
  const { pointsIn, alerts: allAlerts } = watch;

  /**
   * 班报的时间窗**以最后一次采样为终点**，而不是「此刻」。
   *
   * 两个原因：
   * 1. 渲染期不能读时钟（`react-hooks/purity`），而把 `Date.now()` 挪进
   *    state 又要靠 effect 回写，绕一圈只是把复杂度搬了个地方；
   * 2. 这样反而更准 —— 巡检停了（应用关过机）之后再看班报，窗口仍然
   *    落在有数据的那一段上，而不是「后半天全是空的」。
   */
  const latest = useMemo(() => {
    let max = 0;
    for (const point of watch.series)
      if (point.at > max) max = point.at;
    return max;
  }, [watch.series]);
  const to = latest;
  const from = to - hours * 3600_000;

  /** 班报条目（没有采样点的会话也保留，结论会说「没采到」）。 */
  const entries = useMemo(
    () =>
      active.map(({ config, session }) => {
        const points = pointsIn(
          config.sessionId,
          from,
          to
        );
        return {
          sessionName: session.name,
          host: session.host,
          config,
          // 图只画 160 个点：面板宽 380px，再密也是同一个像素列
          chartPoints: downsample(points, 160),
          stats: summarize(
            points,
            allAlerts,
            config.sessionId,
            from,
            to
          )
        };
      }),
    [active, pointsIn, allAlerts, from, to]
  );

  /** 复制整份班报（Markdown）。 */
  function copyReport() {
    const text = buildShiftReport({
      from,
      to,
      entries: entries.map(entry => ({
        sessionName: entry.sessionName,
        host: entry.host,
        stats: entry.stats
      }))
    });
    navigator.clipboard
      .writeText(text)
      .then(() => {
        console.info(
          `[watch] 班报已复制（${entries.length} 台，${hours}h）`
        );
        setHint(t("watch.panel.copied"));
      })
      .catch((reason: unknown) => {
        logError("[watch] 复制班报失败", reason);
        onError(String(reason));
      });
  }

  /** 单条告警交给 AI 归因（用户主动点才发生）。 */
  function askAi(record: WatchAlertRecord) {
    if (
      !onAskAi(
        buildRecordDiagnosis(record),
        record.sessionId
      )
    ) {
      onError(t("watch.aiUnavailable"));
      return;
    }
    // ⚠️ 必须顺手关掉自己：这个面板是**覆盖层**（z-index 28），AI 面板
    // 被它压在下面。不关的话用户点了按钮，屏幕上什么变化都没有 ——
    // 实际提问已经发出去了，看起来却像「点了没反应」（2026-10-25 反馈）。
    onClose();
  }

  /**
   * 面板宽度：与 AI 对话面板同源 —— 同一个默认 390px、同一份拖拽存档。
   *
   * 用惰性初始化读一次（每次打开面板重新读）：`readPrefs()` 里带一次性
   * 迁移副作用，放在渲染表达式里等于每次重渲染都摸一次存储。
   */
  const [panelWidth] = useState(() =>
    Math.max(390, loadPanelWidth() ?? 390)
  );

  return (
    <aside
      className="watch-panel"
      style={
        {
          "--watch-panel-width": `${panelWidth}px`
        } as CSSProperties
      }
    >
      <header className="watch-panel-head">
        <span className="watch-panel-title">
          {t("watch.panel.title")}
        </span>
        <small>
          {t("watch.panel.enabled", {
            count: active.length
          })}
        </small>
        <div className="watch-panel-actions">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={t("app.action.close")}
            onPress={onClose}
          >
            <CloseOutlined />
          </Button>
        </div>
      </header>

      {/* 分段控件而不是 HeroUI Tabs：项目里没有 Tabs 的使用先例，
          两个 tab 用两个按钮手写更可控（样式统一由 .watch-tabs 管） */}
      <div
        className="watch-tabs"
        role="tablist"
        aria-label={t("watch.panel.title")}
      >
        {(["status", "report"] as const).map(
          id => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-active={tab === id}
              className="watch-tab"
              onClick={() => setTab(id)}
            >
              {t(`watch.panel.tab.${id}`)}
            </button>
          )
        )}
      </div>

      <div className="watch-panel-body">
        {hint && (
          <p className="watch-hint">{hint}</p>
        )}
        {active.length === 0 ? (
          <p className="watch-hint">
            {t("watch.panel.empty")}
          </p>
        ) : tab === "status" ? (
          <StatusView
            active={active}
            watch={watch}
            onConfigure={onConfigure}
            onAskAi={askAi}
          />
        ) : (
          <ReportView
            entries={entries}
            range={range}
            onRange={setRange}
            onCopy={copyReport}
          />
        )}
      </div>
    </aside>
  );
}

/** 状态视角：每台机器的当前值 + 最近告警。 */
function StatusView({
  active,
  watch,
  onConfigure,
  onAskAi
}: {
  active: {
    config: WatchConfig;
    session: SavedSession;
  }[];
  watch: ReturnType<typeof useWatch>;
  onConfigure: (session: SavedSession) => void;
  onAskAi: (record: WatchAlertRecord) => void;
}) {
  const t = useT();
  const recent = watch.alerts.slice(0, 10);

  return (
    <>
      <div className="watch-rows">
        {active.map(({ config, session }) => {
          const status = watch.statusOf(
            session.id
          );
          const sample = status.sample;
          const disk = diskOf(config, sample);
          return (
            <div
              className="watch-row"
              key={session.id}
              data-breaching={
                status.breaching.length > 0
              }
            >
              <div className="watch-row-head">
                <strong>{session.name}</strong>
                <small>
                  {session.username
                    ? `${session.username}@`
                    : ""}
                  {session.host}
                </small>
              </div>
              <div className="watch-metrics">
                <Metric
                  label="CPU"
                  value={sample?.cpu}
                />
                <Metric
                  label={t("watch.metric.mem")}
                  value={sample?.mem}
                />
                <Metric
                  label={t("watch.metric.load")}
                  value={
                    sample?.load === null ||
                    sample?.load === undefined
                      ? null
                      : sample.load * 100
                  }
                  text={
                    sample?.load === null ||
                    sample?.load === undefined
                      ? undefined
                      : `${sample.load.toFixed(2)}/核`
                  }
                  raw
                />
                <Metric
                  label={t("watch.metric.disk")}
                  value={disk ? disk.pct : null}
                  // 挂载点不再拼进数值：根分区是 "/"，摆在那里就是
                  // 「/ 12%」——一个孤零零的斜杠看着像多打的字符。
                  // 具体是哪块盘由下方阈值摘要和悬停提示说清。
                  title={disk?.mount}
                />
              </div>
              {/* 「为什么还没告警」：越界了但连续次数没攒够，把它摊开 */}
              {status.pending.length > 0 && (
                <small className="watch-row-pending">
                  {t("watch.panel.pending")}{" "}
                  {status.pending
                    .map(
                      item =>
                        // 磁盘 / 服务要带上对象（挂载点 / 单元名），
                        // 否则「磁盘 91%」看不出是哪块盘
                        `${t(`watch.kind.${item.kind}`)}${item.subject && item.subject !== "/" ? ` ${item.subject}` : ""} ${formatValue(item.kind, item.value)}（${item.count}/${item.need}）`
                    )
                    .join(" · ")}
                </small>
              )}
              <div className="watch-row-foot">
                <span className="watch-hint watch-foot-text">
                  {status.running
                    ? t("watch.panel.sampling")
                    : sample
                      ? `${t("watch.panel.lastSample")} ${fmtTime(sample.at)}`
                      : t("watch.panel.noSample")}
                  {status.breaching.length > 0
                    ? ` · ${t("watch.panel.breaching", { count: status.breaching.length })}`
                    : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  className="watch-icon-btn"
                  aria-label={t(
                    "watch.panel.sample"
                  )}
                  isDisabled={status.running}
                  onPress={() =>
                    void watch.runNow(session.id)
                  }
                >
                  <ReloadOutlined />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  className="watch-icon-btn"
                  aria-label={t(
                    "watch.panel.configure"
                  )}
                  onPress={() =>
                    onConfigure(session)
                  }
                >
                  <SettingOutlined />
                </Button>
              </div>
              {/* 阈值只做展示：让用户一眼看出「这个值离红线多远」 */}
              <small className="watch-row-threshold">
                {thresholdText(config, t)}
              </small>
            </div>
          );
        })}
      </div>

      <h3 className="watch-section-title">
        {t("watch.panel.recent")}
      </h3>
      {recent.length === 0 ? (
        <p className="watch-hint">
          {t("watch.panel.noAlert")}
        </p>
      ) : (
        recent.map(record => (
          <WatchAlertRow
            key={record.id}
            record={record}
            onAskAi={onAskAi}
            onDelete={alert =>
              watch.removeAlert(alert.id)
            }
          />
        ))
      )}
    </>
  );
}

/** 班报视角：一台机器一张卡（图 + 统计 + 一句结论）。 */
function ReportView({
  entries,
  range,
  onRange,
  onCopy
}: {
  entries: {
    sessionName: string;
    host: string;
    config: WatchConfig;
    chartPoints: WatchPoint[];
    stats: ReturnType<typeof summarize>;
  }[];
  range: "shift" | "day";
  onRange: (next: "shift" | "day") => void;
  onCopy: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="watch-report-bar">
        {RANGES.map(item => (
          <Button
            key={item.id}
            size="sm"
            variant={
              range === item.id
                ? "primary"
                : "tertiary"
            }
            className="watch-bar-btn"
            onPress={() => onRange(item.id)}
          >
            {t(
              item.id === "shift"
                ? "watch.panel.rangeShift"
                : "watch.panel.rangeDay"
            )}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="watch-bar-btn watch-report-copy"
          onPress={onCopy}
        >
          {t("watch.panel.copy")}
        </Button>
      </div>
      {/* 说明时间窗的锚点，免得用户以为「本班」= 从此刻往前数。
          单独给个类：默认的 .watch-hint 只有上边距，卡片会紧贴着这行字 */}
      <p className="watch-hint watch-report-hint">
        {t("watch.panel.rangeHint")}
      </p>

      {entries.map(entry => {
        const cpuCheck = entry.config.checks.find(
          check =>
            check.kind === "cpu" && check.enabled
        );
        return (
          <div
            className="watch-report-card"
            key={`${entry.sessionName}:${entry.host}`}
          >
            <div className="watch-row-head">
              <strong>{entry.sessionName}</strong>
              <small>{entry.host}</small>
            </div>
            {entry.stats.samples === 0 ? (
              <p className="watch-hint">
                {t("watch.panel.noData")}
              </p>
            ) : (
              <>
                <WatchChart
                  points={entry.chartPoints}
                  threshold={cpuCheck?.threshold}
                />
                <div className="watch-legend">
                  <span className="watch-legend-cpu">
                    CPU
                  </span>
                  <span className="watch-legend-mem">
                    {t("watch.metric.mem")}
                  </span>
                  {cpuCheck && (
                    <span className="watch-legend-threshold">
                      {t(
                        "watch.metric.threshold"
                      )}{" "}
                      {cpuCheck.threshold}%
                    </span>
                  )}
                </div>
              </>
            )}
            <Typography.Paragraph
              size="sm"
              className="watch-verdict"
            >
              {verdictOf(
                entry.stats,
                entry.sessionName
              )}
            </Typography.Paragraph>
          </div>
        );
      })}
    </>
  );
}

/** 单个指标小方块：有值时带百分比条。 */
function Metric({
  label,
  value,
  text,
  title,
  raw = false
}: {
  label: string;
  value: number | null | undefined;
  text?: string;
  /** 悬停提示（目前只有磁盘用它带挂载点） */
  title?: string;
  raw?: boolean;
}) {
  const pct =
    value === null || value === undefined
      ? null
      : Math.min(100, Math.max(0, value));
  return (
    <div className="watch-metric" title={title}>
      <span className="watch-metric-label">
        {label}
      </span>
      <span className="watch-metric-value">
        {text ??
          (pct === null
            ? "—"
            : `${Math.round(pct)}%`)}
      </span>
      {!raw && (
        <span className="watch-metric-bar">
          <i style={{ width: `${pct ?? 0}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * 磁盘指标：优先显示**真的配了检查**的那个挂载点。
 *
 * 之前一律取「最满的盘」，于是配了 `/` 却显示 `/boot` —— 用户看到的
 * 数字和阈值摘要里的对象对不上，第一反应是「这功能坏了」。
 */
function diskOf(
  config: WatchConfig,
  sample: WatchSample | null | undefined
): { mount: string; pct: number } | null {
  if (!sample) return null;
  const checked = config.checks.find(
    check =>
      check.enabled && check.kind === "disk"
  );
  if (checked) {
    const mount =
      (checked.mount ?? "").trim() || "/";
    const pct = sample.disks[mount];
    if (pct !== undefined) return { mount, pct };
  }
  return busiestDisk(sample.disks);
}

/** 使用率最高的挂载点（没配磁盘检查时的兜底）。 */
function busiestDisk(
  disks: Record<string, number> | undefined
): { mount: string; pct: number } | null {
  if (!disks) return null;
  const entries = Object.entries(disks).sort(
    (left, right) => right[1] - left[1]
  );
  const top = entries[0];
  return top
    ? { mount: top[0], pct: top[1] }
    : null;
}

/** 阈值摘要（一行说清各检查项的红线与连续次数）。 */
function thresholdText(
  config: WatchConfig,
  t: Translator
): string {
  const parts = config.checks
    .filter(check => check.enabled)
    .map(check => {
      const label = t(`watch.kind.${check.kind}`);
      let base: string;
      if (check.kind === "service")
        base = `${label} ${check.unit}`;
      else if (check.kind === "command")
        base = `${label} ${check.command}`;
      else if (check.kind === "disk") {
        // 根分区是默认值，写出来就是「磁盘使用率 / 5%」——那个斜杠同样
        // 会被读成多余字符；非根挂载点才显式标出来
        const mount =
          (check.mount ?? "").trim() || "/";
        base =
          mount === "/"
            ? `${label} ${check.threshold}%`
            : `${label}（${mount}）${check.threshold}%`;
      } else if (check.kind === "load")
        base = `${label} ${check.threshold}`;
      else base = `${label} ${check.threshold}%`;
      // 连续次数必须一起露出来：只写「内存 5%」，用户看到 42% 却不告警
      // 会以为功能坏了（见 PendingBreach）
      return check.consecutive > 1
        ? `${base}（${t(
            "watch.panel.repeatTimes",
            {
              count: check.consecutive
            }
          )}）`
        : base;
    });
  return `${t("watch.panel.interval")} ${config.intervalSec}s · ${parts.join(" · ")}`;
}
