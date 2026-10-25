/**
 * 阈值判定与告警状态机（纯函数，全部可单测）。
 *
 * 这是整个值守里**最容易写错、又最看不出来**的一块：
 * - 连续次数写反 → 抖一下就报警，用户三天后就把通知静音了；
 * - 去重写漏 → 同一条越界每 60 秒弹一次，一晚上几百条；
 * - 恢复写漏 → 告警永远挂着，用户以为还没好。
 *
 * 所以这里不碰任何 IO：输入「配置 + 采样 + 上一次状态」，输出「新状态 +
 * 该发的事件」。发不发、发到哪（系统通知 / 面板角标）由调用方决定，
 * 免打扰时段的判断也留在这里，因为它本质是「这条事件该不该被听见」。
 */

import {
  checkSubject,
  checkValue,
  isBreach
} from "@/watch/lib/watchChecks";
import type {
  QuietHours,
  WatchCheckKind,
  WatchConfig,
  WatchSample
} from "@/watch/lib/watchTypes";

/** 单个检查项的运行状态。 */
export type WatchCheckState = {
  /** 连续越界次数 */
  streak: number;
  /** 是否已处于告警中（已经喊过一次，还没恢复） */
  alerted: boolean;
  /** 上次告警时刻（冷却起点） */
  lastAlertAt: number;
  /** 最近一次取到的值 */
  value: number | null;
};

/** 状态表：键见 `checkKey`。 */
export type WatchStateMap = Record<
  string,
  WatchCheckState
>;

/** 一条待处理的事件。 */
export type WatchEvent = {
  kind: WatchCheckKind | "connect";
  level: "alert" | "recover";
  /** 具体对象：挂载点 / 单元名 / 命令 / 主机 */
  subject: string;
  value: number;
  threshold: number;
  /** 触发时的连续次数（恢复事件为 0） */
  streak: number;
  /** true = 修复冷却后的重复提醒（「仍未恢复」），不是首次告警 */
  repeat: boolean;
};

/** 判定所需的调参。 */
export type EvaluateOptions = {
  /** 同一条告警的重复提醒冷却（毫秒） */
  cooldownMs: number;
  /**
   * 连不上机器的连续次数阈值。
   *
   * 独立于各检查项：网络抖一下就把「CPU 高」和「连不上」混在一起报，
   * 用户会以为服务器同时出了两件事。
   */
  connectConsecutive?: number;
};

/** 连不上机器用的虚拟键（不与真实检查项冲突）。 */
const CONNECT_KEY = "__connect__";

/**
 * 检查项的状态键。
 *
 * 必须带 `subject`：一个会话可以同时配两个磁盘检查（`/` 与 `/data`），
 * 只按 `kind` 作键会让它们共用同一个 streak —— 一个 85% 一个 40%，
 * 轮流把对方的计数重置，永远攒不满连续次数。
 */
export function checkKey(
  sessionId: string,
  kind: string,
  subject = ""
): string {
  return `${sessionId}:${kind}:${subject}`;
}

/** 空状态（首次采样时用）。 */
export function emptyState(): WatchCheckState {
  return {
    streak: 0,
    alerted: false,
    lastAlertAt: 0,
    value: null
  };
}

/**
 * 判断当前是否处于免打扰时段。
 *
 * 支持跨零点（23:00 ~ 08:00）。任一端为空或格式非法一律视为「不启用」——
 * 手改配置文件写坏了不该让所有告警永久静音。
 */
export function inQuietHours(
  now: Date,
  quiet: QuietHours
): boolean {
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null)
    return false;
  if (start === end) return false;
  const minutes =
    now.getHours() * 60 + now.getMinutes();
  return start < end
    ? minutes >= start && minutes < end
    : // 跨零点：23:00~08:00 = [23:00, 24:00) ∪ [00:00, 08:00)
      minutes >= start || minutes < end;
}

/** "23:05" → 1385（分钟）；非法返回 null。 */
export function parseClock(
  text: string
): number | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(
    text.trim()
  );
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 该不该在这一拍跑这个会话。
 *
 * @param lastRunAt 上次采样时刻；0 表示从未跑过
 * @param intervalSec 配置的间隔
 * @param now 当前时刻
 * @param minIntervalSec 全局下限（脚本本身要跑 1 秒以上）
 */
export function isDue(
  lastRunAt: number,
  intervalSec: number,
  now: number,
  minIntervalSec: number
): boolean {
  if (lastRunAt <= 0) return true;
  const gap =
    Math.max(intervalSec, minIntervalSec) * 1000;
  return now - lastRunAt >= gap;
}

/**
 * 对一次采样做判定，返回新状态与事件。
 *
 * 关键语义：
 * - 取不到的值（`null`）**原样保留状态**：这台机器没 systemd，不该把
 *   「服务检查」判成挂了，也不该把它攒着的连续次数清零；
 * - 冷却期内的重复越界不产生事件；冷却到期仍越界会再提醒一次（带
 *   `repeat: true`），因为「一直没好」也是需要知道的信息；
 * - 恢复只发一条，并把状态复位。
 */
export function evaluateSample(
  config: WatchConfig,
  sample: WatchSample,
  state: WatchStateMap,
  now: number,
  options: EvaluateOptions
): {
  state: WatchStateMap;
  events: WatchEvent[];
} {
  const next: WatchStateMap = { ...state };
  const events: WatchEvent[] = [];

  if (!sample.ok) {
    const key = checkKey(
      config.sessionId,
      CONNECT_KEY
    );
    const prev = next[key] ?? emptyState();
    const updated = advance(prev, 0, now, {
      breach: true,
      consecutive:
        options.connectConsecutive ?? 2,
      cooldownMs: options.cooldownMs
    });
    next[key] = updated.state;
    if (updated.event) {
      events.push({
        kind: "connect",
        level: "alert",
        subject: sample.error ?? "连接失败",
        value: 0,
        threshold: 0,
        streak: updated.state.streak,
        repeat: updated.event === "repeat"
      });
    }
    return { state: next, events };
  }

  for (const check of config.checks) {
    if (!check.enabled) continue;
    const value = checkValue(check, sample);
    if (value === null) continue;
    const subject = checkSubject(check);
    const key = checkKey(
      config.sessionId,
      check.kind,
      subject
    );
    const prev = next[key] ?? emptyState();
    const breach = isBreach(check, value);
    const updated = advance(prev, value, now, {
      breach,
      consecutive: Math.max(1, check.consecutive),
      cooldownMs: options.cooldownMs
    });
    next[key] = updated.state;
    if (!updated.event) continue;
    events.push({
      kind: check.kind,
      level: breach ? "alert" : "recover",
      subject,
      value,
      threshold: check.threshold,
      streak: updated.state.streak,
      repeat: updated.event === "repeat"
    });
  }
  return { state: next, events };
}

/**
 * 单个检查项的状态推进。
 *
 * 抽出来是因为「连不上」与「指标越界」走的是同一套计数/冷却逻辑，
 * 复制两份必然有一份先改漏（比如只给指标加了冷却）。
 *
 * @returns event 为 `alert`（首次）/ `repeat`（冷却后再提醒）/ `recover`
 */
function advance(
  prev: WatchCheckState,
  value: number,
  now: number,
  options: {
    breach: boolean;
    consecutive: number;
    cooldownMs: number;
  }
): {
  state: WatchCheckState;
  event: "alert" | "repeat" | "recover" | null;
} {
  if (!options.breach) {
    const recovered = prev.alerted;
    return {
      state: {
        streak: 0,
        alerted: false,
        lastAlertAt: prev.lastAlertAt,
        value
      },
      event: recovered ? "recover" : null
    };
  }
  const streak = prev.streak + 1;
  if (!prev.alerted) {
    if (streak < options.consecutive)
      return {
        state: {
          ...prev,
          streak,
          value
        },
        event: null
      };
    return {
      state: {
        streak,
        alerted: true,
        lastAlertAt: now,
        value
      },
      event: "alert"
    };
  }
  // 已经在告警中：冷却期内一律闭嘴
  if (
    now - prev.lastAlertAt >=
    options.cooldownMs
  )
    return {
      state: {
        streak,
        alerted: true,
        lastAlertAt: now,
        value
      },
      event: "repeat"
    };
  return {
    state: {
      ...prev,
      streak,
      value
    },
    event: null
  };
}

/**
 * 把事件翻译成一句人话（通知正文与面板共用）。
 *
 * 文案里带**数值和阈值**：只说「CPU 高」用户没法判断要不要现在起身，
 * 「CPU 94%（阈值 90%）」能。
 */
export function describeEvent(
  event: WatchEvent,
  sessionName: string
): string {
  if (event.kind === "connect")
    return `${sessionName} · 巡检连不上：${event.subject}`;
  const label = KIND_LABEL[event.kind];
  if (event.level === "recover")
    return `${sessionName} · ${label} 已恢复（${formatValue(event.kind, event.value)}）`;
  const prefix = event.repeat
    ? "仍未恢复"
    : "告警";
  if (event.kind === "service")
    return `${sessionName} · 服务 ${event.subject} ${event.repeat ? "仍然未运行" : "未运行"}`;
  if (event.kind === "command")
    return `${sessionName} · 检查未通过：${event.subject}（${prefix}）`;
  return `${sessionName} · ${label} ${formatValue(event.kind, event.value)}（阈值 ${formatValue(event.kind, event.threshold)}，${prefix}）`;
}

/** 检查项的中文名（通知正文用；界面上的文案走 i18n）。 */
export const KIND_LABEL: Record<
  WatchCheckKind | "connect",
  string
> = {
  cpu: "CPU",
  mem: "内存",
  disk: "磁盘",
  load: "负载",
  service: "服务",
  command: "自定义检查",
  // 「连不上机器」不是用户配的检查项，但它也会产生告警记录
  connect: "连接"
};

/** 数值格式化：负载保留两位，其余取整百分比。 */
export function formatValue(
  kind: WatchEvent["kind"],
  value: number
): string {
  if (kind === "load")
    return `${value.toFixed(2)}/核`;
  if (kind === "service" || kind === "command")
    return value ? "通过" : "未通过";
  return `${Math.round(value)}%`;
}

/** 已越界、但还没攒够连续次数的检查项。 */
export type PendingBreach = {
  kind: WatchCheckKind;
  subject: string;
  value: number;
  /** 已连续越界几次 */
  count: number;
  /** 需要几次才告警 */
  need: number;
};

/**
 * 挑出「越界了但还在攒次数」的项。
 *
 * 面板靠它回答用户最常问的那句「为什么没有告警」：阈值 5%、实测 42%，
 * 却因为连续次数 3 而静默 —— 不给这个中间态，界面上就只有「暂无告警」，
 * 看起来像功能坏了（2026-10-25 实测）。
 *
 * 抽成纯函数是为了能单测：它依赖 `checkKey` 的键格式，键拼错了就永远
 * 匹配不到状态，症状同样是「不显示」。
 */
export function pendingBreaches(
  config: WatchConfig,
  state: WatchStateMap
): PendingBreach[] {
  return config.checks
    .filter(check => check.enabled)
    .flatMap(check => {
      const subject = checkSubject(check);
      const item =
        state[
          checkKey(
            config.sessionId,
            check.kind,
            subject
          )
        ];
      if (
        !item ||
        item.alerted ||
        item.streak <= 0 ||
        item.value === null
      )
        return [];
      return [
        {
          kind: check.kind,
          subject,
          value: item.value,
          count: item.streak,
          need: Math.max(1, check.consecutive)
        }
      ];
    });
}
