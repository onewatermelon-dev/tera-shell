/**
 * 班报的统计与结论（纯函数，全部可单测）。
 *
 * ## 为什么结论是算出来的，不是问 AI 的
 *
 * 「一句结论」听着像模型该干的活，但班报要的是**可复述的事实**：
 * 均值多少、峰值几点、哪块盘越过线、几次越界。这些全都能从采样序列
 * 直接算出来，而且算出来的数字用户能核对 —— 换成模型生成，反而多出
 * 「它是不是说错了」的疑虑，还要为每份班报付一次调用。
 *
 * 真要归因（「为什么会这样」），走告警记录上的「让 AI 归因」按钮，
 * 那是用户主动发起的，和这里的分工一致。
 *
 * ## 缺失值不参与平均
 *
 * 巡检可能中途连不上机器，`cpu` 为 `null`。把 null 当 0 计算会把均值
 * 拉低，班报就会出现「CPU 平均 3%」这种明显不对的数字 —— 而它看起来
 * 又很合理，最容易被当成结论抄进工单。
 */

import type {
  WatchAlertRecord,
  WatchCheckKind,
  WatchPoint
} from "@/watch/lib/watchTypes";

/** 单个指标的统计。 */
export type MetricStat = {
  avg: number;
  min: number;
  max: number;
  /** 峰值出现的时刻 */
  maxAt: number;
  /** 参与计算的样本数（不含 null） */
  count: number;
};

/** 一段时间的班报统计。 */
export type ShiftStats = {
  from: number;
  to: number;
  /** 采样点总数（含缺失值的点） */
  samples: number;
  cpu: MetricStat | null;
  mem: MetricStat | null;
  load: MetricStat | null;
  /**
   * 磁盘：只统计「最忙的那块盘」。
   *
   * 不同时刻最忙的盘可能是不同的（今天 /var 满、明天 /data 满），
   * 所以先选出现次数最多的挂载点，再只对它算均值 —— 混着算出来的
   * 「平均 62%」既不属于任何一块盘，也没有行动价值。
   */
  disk:
    | (MetricStat & {
        mount: string;
        /** 期末 - 期初（百分点），正数 = 在涨 */
        delta: number;
      })
    | null;
  /** 该时段内的告警记录（按时间正序） */
  alerts: WatchAlertRecord[];
  /** 越界次数（只算 alert，不算 recover） */
  breachCount: number;
};

/** 单条序列的统计；空序列返回 null。 */
function statOf(
  values: { at: number; value: number | null }[]
): MetricStat | null {
  const valid = values.filter(
    (
      item
    ): item is { at: number; value: number } =>
      item.value !== null &&
      Number.isFinite(item.value)
  );
  if (valid.length === 0) return null;
  let sum = 0;
  let max = valid[0]!.value;
  let min = valid[0]!.value;
  let maxAt = valid[0]!.at;
  for (const item of valid) {
    sum += item.value;
    if (item.value > max) {
      max = item.value;
      maxAt = item.at;
    }
    if (item.value < min) min = item.value;
  }
  return {
    avg: sum / valid.length,
    min,
    max,
    maxAt,
    count: valid.length
  };
}

/**
 * 汇总一段时间的班报。
 *
 * @param points 该会话在窗口内的采样（时间正序，见 `pointsOf`）
 * @param alerts 全部告警（函数内按会话与窗口筛）
 * @param sessionId 目标会话
 */
export function summarize(
  points: WatchPoint[],
  alerts: WatchAlertRecord[],
  sessionId: string,
  from: number,
  to: number
): ShiftStats {
  const inWindow = points.filter(
    point => point.at >= from && point.at <= to
  );
  const shiftAlerts = alerts
    .filter(
      record =>
        record.sessionId === sessionId &&
        record.at >= from &&
        record.at <= to
    )
    .sort((left, right) => left.at - right.at);

  // 最忙的盘：按出现次数投票，平票取更满的那个
  const votes = new Map<string, number[]>();
  for (const point of inWindow) {
    if (!point.disk) continue;
    const list =
      votes.get(point.disk.mount) ?? [];
    list.push(point.disk.pct);
    votes.set(point.disk.mount, list);
  }
  let mount = "";
  let mountCount = -1;
  for (const [name, list] of votes) {
    if (list.length > mountCount) {
      mount = name;
      mountCount = list.length;
    }
  }
  const diskValues = inWindow.map(point => ({
    at: point.at,
    value:
      point.disk && point.disk.mount === mount
        ? point.disk.pct
        : null
  }));
  const diskStat = mount
    ? statOf(diskValues)
    : null;
  const firstDisk = diskValues.find(
    item => item.value !== null
  );
  const lastDisk = [...diskValues]
    .reverse()
    .find(item => item.value !== null);

  return {
    from,
    to,
    samples: inWindow.length,
    cpu: statOf(
      inWindow.map(point => ({
        at: point.at,
        value: point.cpu
      }))
    ),
    mem: statOf(
      inWindow.map(point => ({
        at: point.at,
        value: point.mem
      }))
    ),
    load: statOf(
      inWindow.map(point => ({
        at: point.at,
        value: point.load
      }))
    ),
    disk:
      diskStat && firstDisk && lastDisk
        ? {
            ...diskStat,
            mount,
            delta:
              (lastDisk.value ?? 0) -
              (firstDisk.value ?? 0)
          }
        : null,
    alerts: shiftAlerts,
    breachCount: shiftAlerts.filter(
      record => record.level === "alert"
    ).length
  };
}

/** 结论里可能出现的中文指标名。 */
const KIND_TEXT: Record<
  WatchCheckKind | "connect",
  string
> = {
  cpu: "CPU",
  mem: "内存",
  disk: "磁盘",
  load: "负载",
  service: "服务",
  command: "自定义检查",
  connect: "连接"
};

/**
 * 把统计变成一句结论。
 *
 * 顺序刻意是「先说什么坏了，再说什么还行」：读班报的人只想知道
 * 「这一班有没有事」。没有告警时才退到峰值描述。
 */
export function verdictOf(
  stats: ShiftStats,
  sessionName: string
): string {
  if (stats.samples === 0)
    return `${sessionName}：这段时间没有采到数据（值守可能没开，或一直连不上）。`;

  const head = `${sessionName}：`;
  if (stats.breachCount > 0) {
    // 越界对象去重，保留出现顺序：一句话里说清「哪几项出过问题」
    const subjects = [
      ...new Set(
        stats.alerts
          .filter(
            record => record.level === "alert"
          )
          .map(
            record =>
              `${KIND_TEXT[record.kind]}${record.kind === "cpu" || record.kind === "mem" || record.kind === "load" ? "" : ` ${record.subject}`}`
          )
      )
    ].slice(0, 3);
    const peak = stats.cpu
      ? `，CPU 峰值 ${Math.round(stats.cpu.max)}%`
      : "";
    return `${head}${stats.breachCount} 次越界（${subjects.join("、")}）${peak}，详见下方告警明细。`;
  }

  const parts: string[] = [];
  if (stats.cpu)
    parts.push(
      `CPU 均值 ${Math.round(stats.cpu.avg)}%、峰值 ${Math.round(stats.cpu.max)}%`
    );
  if (stats.mem)
    parts.push(
      `内存均值 ${Math.round(stats.mem.avg)}%`
    );
  if (stats.disk) {
    const trend =
      stats.disk.delta > 1
        ? `，上涨 ${stats.disk.delta.toFixed(1)} 个百分点`
        : stats.disk.delta < -1
          ? `，下降 ${Math.abs(stats.disk.delta).toFixed(1)} 个百分点`
          : "，基本持平";
    parts.push(
      `${stats.disk.mount} 使用率 ${Math.round(stats.disk.avg)}%${trend}`
    );
  }
  const busy =
    (stats.cpu && stats.cpu.max >= 80) ||
    (stats.mem && stats.mem.max >= 90);
  return busy
    ? `${head}无越界，但有短时高负载（${parts.join("，")}）。`
    : `${head}运行平稳，无越界（${parts.join("，")}）。`;
}

/**
 * 降采样到至多点数（画图用）。
 *
 * 用**分桶平均**而不是抽点：抽点会漏掉尖峰，而班报图上最该看见的恰恰
 * 是那个尖峰。分桶平均也会削弱尖峰，所以桶内保留最大值更合适 ——
 * 这里取「桶内最大值」，宁可把图画得保守（偏高），也不要把事故抹平。
 */
export function downsample(
  points: WatchPoint[],
  maxPoints: number
): WatchPoint[] {
  if (
    points.length <= maxPoints ||
    maxPoints <= 0
  )
    return points;
  const bucketSize = Math.ceil(
    points.length / maxPoints
  );
  const out: WatchPoint[] = [];
  for (
    let index = 0;
    index < points.length;
    index += bucketSize
  ) {
    const bucket = points.slice(
      index,
      index + bucketSize
    );
    const pick = (
      key: "cpu" | "mem" | "load"
    ) => {
      let best: number | null = null;
      for (const point of bucket) {
        const value = point[key];
        if (value === null) continue;
        if (best === null || value > best)
          best = value;
      }
      return best;
    };
    // 时间取桶内最后一个（右边界），图上的 x 才不会整体左移
    const last = bucket[bucket.length - 1]!;
    const busiest = bucket
      .map(point => point.disk)
      .filter(
        (
          disk
        ): disk is {
          mount: string;
          pct: number;
        } => disk !== null
      )
      .sort(
        (left, right) => right.pct - left.pct
      )[0];
    out.push({
      at: last.at,
      sessionId: last.sessionId,
      cpu: pick("cpu"),
      mem: pick("mem"),
      load: pick("load"),
      disk: busiest ?? null
    });
  }
  return out;
}
