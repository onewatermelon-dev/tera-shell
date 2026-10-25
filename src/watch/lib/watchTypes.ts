/**
 * 值守巡检的数据模型。
 *
 * 值守与「失败即诊断」（`terminal/lib/failureDiagnosis.ts`）是同一条思路的
 * 两个方向：
 * - 失败即诊断是**事件驱动**的，命令跑挂了顺手把现场备好，等人来问；
 * - 值守是**时间驱动**的，没人问也得看两眼，越过了红线才叫人。
 *
 * 两者共享同一条铁律：**巡检本身绝不调模型**。每次采样只跑只读命令 +
 * 比大小，命中了才把现场打包成文本等用户点「让 AI 归因」—— 一个 60 秒
 * 巡检跑一夜就是上千次采样，任何一次顺手问模型都等于烧钱。
 */

/** 检查项类型。 */
export type WatchCheckKind =
  | "cpu"
  | "mem"
  | "disk"
  | "load"
  | "service"
  | "command";

/**
 * 一个检查项。
 *
 * `threshold` 的语义随类型变化，且**都归一化过**，别直接对着原始值比：
 * - cpu / mem / disk：百分比（0–100）
 * - load：**每核**负载（`load1 / nproc`），> 1 意味着进程在排队
 * - service / command：不使用阈值，只看「活着 / 匹配上」
 */
export type WatchCheck = {
  kind: WatchCheckKind;
  enabled: boolean;
  /** 阈值：百分比或每核负载（见类型注释） */
  threshold: number;
  /**
   * 连续多少次越界才告警。
   *
   * 为什么不是「一次就报」：CPU 抖一下、`df` 恰好赶上日志切割，都会造成
   * 单点毛刺。值守的第一原则是**别喊狼来了** —— 误报三次之后，用户就会
   * 把通知静音，功能等于没做。
   */
  consecutive: number;
  /** disk：挂载点，空串 = 根分区 `/` */
  mount?: string;
  /** service：systemd 单元名（如 `nginx`、`docker.service`） */
  unit?: string;
  /** command：只读命令；输出非空即视为有结果 */
  command?: string;
  /** command：输出必须匹配的文本；空串 = 只看退出码 */
  expect?: string;
};

/** 一个会话的巡检配置。 */
export type WatchConfig = {
  /** 对应 `SavedSession.id`（本地会话无 exec 通道，不支持） */
  sessionId: string;
  /** 该会话是否参与巡检 */
  enabled: boolean;
  /** 采样间隔（秒）；实际生效值不得低于 `MIN_WATCH_INTERVAL_SEC` */
  intervalSec: number;
  checks: WatchCheck[];
};

/** 免打扰时段（"23:00" ~ "08:00" 这类，跨零点也支持）。 */
export type QuietHours = {
  /** 空串 = 不启用免打扰 */
  start: string;
  end: string;
};

/** 一次采样的结果。任一项取不到时为 `null`，不参与判定。 */
export type WatchSample = {
  /** 采样时刻（毫秒） */
  at: number;
  /** exec 是否成功；false 时其余字段无意义 */
  ok: boolean;
  /** exec 失败原因（给面板与日志看） */
  error?: string;
  cpu: number | null;
  mem: number | null;
  /** 每核负载 */
  load: number | null;
  cores: number;
  /** 挂载点 → 使用率（%） */
  disks: Record<string, number>;
  /** 单元名 → systemd 状态（active / inactive / failed / unknown） */
  services: Record<string, string>;
  /** 自定义命令的标准输出（已 trim） */
  commandOutput: string;
  /** 自定义命令的退出码 */
  commandExit: number;
  /** 原始输出（截断），事后归因时交给模型 */
  raw: string;
};

/** 一条告警 / 恢复记录。 */
export type WatchAlertRecord = {
  id: string;
  sessionId: string;
  /** 会话名的快照：会话后来被删掉了，历史里仍要认得出是哪台 */
  sessionName: string;
  kind: WatchCheckKind | "connect";
  level: "alert" | "recover";
  /** 越界值；connect 类告警为 0 */
  value: number;
  threshold: number;
  /** 具体对象：挂载点 / 单元名 / 命令 */
  subject: string;
  at: number;
  /** 触发时的采样摘要（截断），事后归因用 */
  detail: string;
};

/** 一条采样点（班报画图用）。 */
export type WatchPoint = {
  at: number;
  sessionId: string;
  cpu: number | null;
  mem: number | null;
  load: number | null;
  /**
   * 使用率最高的那个磁盘。
   *
   * 只留一个而不是全量：一台机器五六个挂载点全画到同一张图上是糊的，
   * 班报要说明的是「有没有一块盘快满了」，最满的那块就够。
   */
  disk: { mount: string; pct: number } | null;
};

/** `watch.json` 的整体结构。 */
export type WatchFile = {
  configs: WatchConfig[];
  quiet: QuietHours;
  /** 同一条告警的重复提醒冷却（分钟） */
  cooldownMin: number;
  /** 告警历史（新的在前，限长） */
  alerts: WatchAlertRecord[];
  /** 采样时序（新的在前，按会话分桶限长） */
  series: WatchPoint[];
};

/** 巡检间隔下限（秒）：脚本本身含一次 sleep 1，再密就是压测。 */
export const MIN_WATCH_INTERVAL_SEC = 30;

/** 默认采样间隔：一分钟。够快发现问题，又不会让远端觉得被打扰。 */
export const DEFAULT_WATCH_INTERVAL_SEC = 60;

/** 告警历史保留条数。 */
export const ALERT_HISTORY_LIMIT = 200;

/**
 * 每个会话保留多少个采样点。
 *
 * 720 个点：60 秒间隔下是 12 小时，正好覆盖一个夜班；30 秒间隔下是 6 小时，
 * 也够一份「本班」班报。再往上存只会让 `watch.json` 变成没人读的日志文件
 * —— 真要长期趋势该去接 Prometheus，不是在这里囤。
 */
export const SERIES_PER_SESSION = 720;

/** 采样点总数上限（防多会话把文件撑爆）。 */
export const SERIES_TOTAL_LIMIT = 6000;

/** 默认冷却：30 分钟。同一条告警持续越界时，半小时提一次足够。 */
export const DEFAULT_COOLDOWN_MIN = 30;

/**
 * 每类检查的出厂默认值。
 *
 * 阈值不是随便拍的：磁盘 85% 是「该清了」的通用经验线；CPU 90% 才值得
 * 半夜叫人；每核负载 2 表示平均每个核排两个任务，明显过载。
 */
export const CHECK_DEFAULTS: Record<
  WatchCheckKind,
  Pick<WatchCheck, "threshold" | "consecutive">
> = {
  cpu: { threshold: 90, consecutive: 3 },
  mem: { threshold: 90, consecutive: 3 },
  disk: { threshold: 85, consecutive: 2 },
  load: { threshold: 2, consecutive: 3 },
  // 服务挂了就是挂了，一次就报 —— 这一项最不该等
  service: { threshold: 0, consecutive: 1 },
  command: { threshold: 0, consecutive: 2 }
};

/** 新建一个检查项（带默认值）。 */
export function makeCheck(
  kind: WatchCheckKind
): WatchCheck {
  const base: WatchCheck = {
    kind,
    enabled: false,
    ...CHECK_DEFAULTS[kind],
    consecutive: CHECK_DEFAULTS[kind].consecutive
  };
  if (kind === "disk")
    return { ...base, mount: "/" };
  if (kind === "service")
    return { ...base, unit: "" };
  if (kind === "command")
    return { ...base, command: "", expect: "" };
  return base;
}

/** 一个会话的默认巡检配置：全关，等用户自己勾。 */
export function defaultConfig(
  sessionId: string
): WatchConfig {
  return {
    sessionId,
    enabled: false,
    intervalSec: DEFAULT_WATCH_INTERVAL_SEC,
    checks: [
      makeCheck("cpu"),
      makeCheck("mem"),
      makeCheck("disk"),
      makeCheck("load"),
      makeCheck("service"),
      makeCheck("command")
    ]
  };
}

/** 空配置文件的初始值。 */
export function emptyWatchFile(): WatchFile {
  return {
    configs: [],
    quiet: { start: "", end: "" },
    cooldownMin: DEFAULT_COOLDOWN_MIN,
    alerts: [],
    series: []
  };
}

/**
 * 从一次采样里提取「要长期记住的那几个数」。
 *
 * 不直接把整个 `WatchSample` 存下来：raw 输出动辄几 KB，720 个点就是几 MB。
 * 班报要的只是趋势，`raw` 属于「当时给 AI 看」的一次性材料，已经在告警
 * 记录里留过一份了。
 */
export function toPoint(
  sessionId: string,
  sample: WatchSample
): WatchPoint {
  const entries = Object.entries(sample.disks);
  const busiest = entries.sort(
    (left, right) => right[1] - left[1]
  )[0];
  return {
    at: sample.at,
    sessionId,
    cpu: sample.cpu,
    mem: sample.mem,
    load: sample.load,
    disk: busiest
      ? { mount: busiest[0], pct: busiest[1] }
      : null
  };
}
