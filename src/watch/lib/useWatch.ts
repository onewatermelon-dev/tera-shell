/**
 * 值守巡检的执行引擎。
 *
 * ## 分工
 *
 * - **定时**：后端心跳（`watch://tick`）—— 前端 `setInterval` 在窗口最小化
 *   时会被 WebView2 节流，而值守恰恰是「窗口在后台」时才需要准点（见
 *   `src-tauri/src/watch/mod.rs`）；
 * - **采样**：复用 AI 面板的 exec 通道（`aiRunCommandQuiet`）—— 不经过终端
 *   PTY，不污染用户正在敲字的会话，连接按主机复用；用 quiet 变体是因为
 *   巡检脚本只读，不该每分钟触发一次目录栏重读；
 * - **判定**：`watchRules.evaluateSample`（纯函数，可单测）；
 * - **通知**：注入的 `notify`，内部走设置开关 + 窗口焦点判定。
 *
 * ## 三条不能破的纪律
 *
 * 1. **巡检不调 AI**：这里只跑只读脚本、比大小。要归因等用户点（见
 *    `watchDiagnosis.ts`）；
 * 2. **同一会话不并行**：上一轮还没回来就跳过这一拍，不是排队 —— 服务器
 *    慢的时候排队只会让积压越滚越大，而巡检看的是「现在」；
 * 3. **连不上也算采样**：`ok: false` 同样进判定（连续两次才报），否则
 *    机器失联是「安静地什么都不发生」，比误报危险得多。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SavedSession } from "@/sessions/lib/session";
import { buildSshTarget } from "@/sessions/lib/sshTarget";
import { logWarn } from "@/shared/lib/log";
import { aiRunCommandQuiet } from "@/terminal/lib/ai/aiExec";
import {
  buildWatchScript,
  parseWatchSample
} from "@/watch/lib/watchChecks";
import {
  describeEvent,
  evaluateSample,
  inQuietHours,
  isDue,
  pendingBreaches,
  type PendingBreach,
  type WatchEvent,
  type WatchStateMap
} from "@/watch/lib/watchRules";
import {
  appendAlerts,
  appendPoints,
  loadWatchFile,
  pointsOf,
  saveWatchFile
} from "@/watch/lib/watchStore";
import {
  MIN_WATCH_INTERVAL_SEC,
  toPoint,
  type WatchAlertRecord,
  type WatchConfig,
  type WatchFile,
  type WatchPoint,
  type WatchSample
} from "@/watch/lib/watchTypes";

/** 心跳事件名，与 `src-tauri/src/watch/mod.rs` 的 `TICK_EVENT` 逐字一致。 */
const TICK_EVENT = "watch://tick";

/**
 * 心跳间隔（秒）。
 *
 * 取各会话间隔的公约数没必要：这一拍只是「问一句有没有到期的」，
 * 真正的节流在 `isDue` 里按每个会话自己的 `intervalSec` 判。
 * 15 秒的代价是后端每 15 秒发一个空事件（可忽略），换来的是
 * 30 秒间隔的配置也能基本准点。
 */
const TICK_SEC = 15;

/**
 * 采样点攒够几个才落盘。
 *
 * 每采一次就写一遍整个 `watch.json`（含 `series`）成本不低：几分钟一次
 * 无所谓，几十台机器一小时内就会变成持续的磁盘写入。攒 5 个写一次，
 * 最坏丢 5 分钟的数据 —— 对班报这种按小时看的产物没有影响，而告警
 * 是命中就立刻落盘的（那一刻本来就要写）。
 */
const POINT_FLUSH_EVERY = 5;

/** 单个会话的实时状态。 */
export type WatchStatus = {
  sample: WatchSample | null;
  lastRunAt: number;
  running: boolean;
  /** 当前处于告警中的检查项（面板角标用） */
  breaching: string[];
  /**
   * 已越界但还在攒次数的项。
   *
   * 没有这个，「阈值 5% 而实测 42% 却不告警」在界面上完全解释不通 ——
   * 用户只能怀疑功能坏了。把 `1/3` 摊开给他看，规则就是透明的。
   */
  pending: PendingBreach[];
};

/** 还没采过样的初始状态。 */
const IDLE_STATUS: WatchStatus = {
  sample: null,
  lastRunAt: 0,
  running: false,
  breaching: [],
  pending: []
};

/** 通知出口（由 App 注入，内部已带设置开关与窗口焦点判定）。 */
export type WatchNotify = (
  summary: string,
  level: "alert" | "recover",
  repeat: boolean
) => void;

/** 构造一条「采样失败」的结果，参与同一套判定。 */
function failedSample(
  error: string,
  at: number
): WatchSample {
  return {
    at,
    ok: false,
    error,
    cpu: null,
    mem: null,
    load: null,
    cores: 0,
    disks: {},
    services: {},
    commandOutput: "",
    commandExit: 0,
    raw: ""
  };
}

/**
 * 建立并维持值守巡检。
 *
 * @param options.sessions 全部已保存会话（跳板链解析要有全集）
 * @param options.notify 发通知
 * @param options.onError 需要让用户看见的失败（连不上不在此列，那属于告警）
 */
export function useWatch(options: {
  sessions: SavedSession[];
  notify: WatchNotify;
  onError?: (message: string) => void;
}) {
  // 配置只在「重新加载」时变（弹窗保存后），与告警历史分开存 ——
  // 否则每来一条告警都会重挂心跳 effect
  const [configs, setConfigs] = useState<
    WatchConfig[]
  >(() => loadWatchFile().configs);
  const [alerts, setAlerts] = useState<
    WatchAlertRecord[]
  >(() => loadWatchFile().alerts);
  const [series, setSeries] = useState<
    WatchPoint[]
  >(() => loadWatchFile().series);
  const [statuses, setStatuses] = useState<
    Record<string, WatchStatus>
  >({});

  /** 配置/历史/设置的最新值；tick 回调靠它读，避免闭包读到旧值。 */
  const fileRef = useRef<WatchFile>(
    loadWatchFile()
  );
  /** 判定状态：会话 id → 检查项状态表。 */
  const statesRef = useRef<
    Record<string, WatchStateMap>
  >({});
  const sessionsRef = useRef(options.sessions);
  const notifyRef = useRef(options.notify);
  const errorRef = useRef(options.onError);
  /** 实时状态的镜像：到期判断要读它，但不能进 tick 的依赖（会反复重建）。 */
  const statusesRef = useRef<
    Record<string, WatchStatus>
  >({});
  /** 正在跑的会话；同一会话不并行。 */
  const inflight = useRef(new Set<string>());
  /** 已采样但还没落盘的点（见 `POINT_FLUSH_EVERY`）。 */
  const pendingPoints = useRef<WatchPoint[]>([]);

  // 渲染期不写 ref（并发渲染下会读到「未来」的值），统一放 effect
  useEffect(() => {
    sessionsRef.current = options.sessions;
  }, [options.sessions]);
  useEffect(() => {
    notifyRef.current = options.notify;
  }, [options.notify]);
  useEffect(() => {
    errorRef.current = options.onError;
  }, [options.onError]);

  /** 更新单个会话的实时状态。 */
  const patchStatus = useCallback(
    (
      sessionId: string,
      patch: Partial<WatchStatus>
    ) => {
      setStatuses(current => ({
        ...current,
        [sessionId]: {
          ...(current[sessionId] ?? IDLE_STATUS),
          ...patch
        }
      }));
    },
    []
  );

  /** 重新读盘（配置弹窗保存后调用）。 */
  const reload = useCallback(() => {
    const next = loadWatchFile();
    fileRef.current = next;
    setConfigs(next.configs);
    setAlerts(next.alerts);
    setSeries(next.series);
    console.info(
      `[watch] 已重新加载巡检配置：${next.configs.filter(c => c.enabled).length} 个会话启用`
    );
  }, []);

  /**
   * 删除一条告警记录（面板/弹窗里的垃圾桶按钮）。
   *
   * 直接改内存并落盘，不做二次确认：单条历史记录、删错了也只是少一条
   * 线索，弹个确认框反而比误删更烦。日志留一行，事后能看出来删过。
   */
  const removeAlert = useCallback(
    (id: string) => {
      const file = fileRef.current;
      const next: WatchFile = {
        ...file,
        alerts: file.alerts.filter(
          item => item.id !== id
        )
      };
      if (
        next.alerts.length === file.alerts.length
      )
        return;
      fileRef.current = next;
      setAlerts(next.alerts);
      saveWatchFile(next);
      console.info(
        `[watch] 已删除告警记录 ${id}`
      );
    },
    []
  );

  /**
   * 跑一轮采样（单个会话）。
   *
   * @returns 是否有事件需要关注（供「立即采样」给个反馈）
   */
  const runOnce = useCallback(
    async (
      config: WatchConfig
    ): Promise<boolean> => {
      const session = sessionsRef.current.find(
        item => item.id === config.sessionId
      );
      // 本地会话没有 exec 通道：配置留着但不跑（界面上已说明）
      if (!session || session.kind === "local")
        return false;
      if (inflight.current.has(config.sessionId))
        return false;
      inflight.current.add(config.sessionId);
      patchStatus(config.sessionId, {
        running: true
      });
      try {
        let sample: WatchSample;
        try {
          const target = await buildSshTarget(
            session,
            sessionsRef.current
          );
          const result = await aiRunCommandQuiet(
            target,
            buildWatchScript(config.checks)
          );
          sample = parseWatchSample(
            result.stdout,
            Date.now()
          );
          // 脚本本身没跑起来（命令不存在、权限不足）也算采集失败：
          // 此时 stdout 是空的，解析出来是「全空指标」，会被当成「一切正常」
          if (
            result.exitCode !== 0 &&
            !sample.raw.trim()
          ) {
            sample = failedSample(
              `巡检脚本退出码 ${result.exitCode}${
                result.stderr.trim()
                  ? `：${result.stderr.trim().slice(0, 200)}`
                  : ""
              }`,
              sample.at
            );
          }
        } catch (reason) {
          logWarn(
            `[watch] 会话 ${config.sessionId} 采样失败`,
            reason
          );
          sample = failedSample(
            String(reason),
            Date.now()
          );
        }

        const now = Date.now();
        const file = fileRef.current;
        const { state, events } = evaluateSample(
          config,
          sample,
          statesRef.current[config.sessionId] ??
            {},
          now,
          {
            cooldownMs:
              Math.max(1, file.cooldownMin) *
              60_000
          }
        );
        statesRef.current[config.sessionId] =
          state;

        patchStatus(config.sessionId, {
          running: false,
          lastRunAt: now,
          sample,
          // 进行中的告警从**状态表**推，不是从本轮事件推：冷却期内的事件
          // 是空的，按事件算会让角标在「仍然有问题」的时候自己消失
          breaching: Object.entries(state)
            .filter(([, item]) => item.alerted)
            .map(([key]) => key),
          // 越界了但还没攒够次数的，单独列出来（见 PendingBreach 注释）
          pending: pendingBreaches(config, state)
        });

        // 采到的点先进内存：连不上（ok=false）不记点 —— 序列里留空档，
        // 让人一眼看出「这段没数据」，而不是被 0 值填平
        if (sample.ok)
          pendingPoints.current.push(
            toPoint(config.sessionId, sample)
          );

        if (events.length > 0) {
          // 静默时段：照常记录，只是不弹 —— 半夜的磁盘告警大多数可以早上再看
          const quiet = inQuietHours(
            new Date(now),
            file.quiet
          );
          for (const event of events) {
            const summary = describeEvent(
              event,
              session.name
            );
            if (quiet) {
              console.info(
                `[watch] 免打扰时段，不通知：${summary}`
              );
              continue;
            }
            notifyRef.current(
              summary,
              event.level,
              event.repeat
            );
          }
        }

        // 告警命中立刻落盘（这一刻本来就要写）；否则攒够一批再写
        if (
          events.length === 0 &&
          pendingPoints.current.length <
            POINT_FLUSH_EVERY
        )
          return false;

        const records = events.map(event =>
          toRecord(
            event,
            config.sessionId,
            session.name,
            sample
          )
        );
        const withPoints = appendPoints(
          file,
          pendingPoints.current
        );
        const next = appendAlerts(
          withPoints,
          records
        );
        pendingPoints.current = [];
        fileRef.current = next;
        setAlerts(next.alerts);
        setSeries(next.series);
        saveWatchFile(next);
        return events.length > 0;
      } finally {
        // ⚠️ 释放必须写在 finally 里：这个函数有多个 return 路径（跳过落盘、
        // 正常收尾），任何一条漏了释放，该会话就永远停在「正在跑」，
        // 之后每一拍都被上面的 `has()` 挡掉 —— 症状是**只采到第一次，
        // 之后再无采样，也永远攒不满连续次数**（2026-10-25 实测踩到：
        // 面板上「上次采样」停在 16 分钟前，用户问「为什么没有告警」）。
        inflight.current.delete(config.sessionId);
      }
    },
    [patchStatus]
  );

  /**
   * 心跳回调：挑出到期的会话，逐个跑。
   *
   * 串行而不是 `Promise.all`：一次巡检并发打十几台机器，在堡垒机上
   * 很容易触发连接数限制，反而让所有会话一起失败。串行的代价是
   * 「最后一台晚几秒」，对 60 秒粒度的巡检没有区别。
   */
  const tick = useCallback(
    async (at: number) => {
      const list = fileRef.current.configs.filter(
        config => config.enabled
      );
      if (list.length === 0) return;
      for (const config of list) {
        const lastRunAt =
          statusesRef.current[config.sessionId]
            ?.lastRunAt ?? 0;
        if (
          !isDue(
            lastRunAt,
            config.intervalSec,
            at,
            MIN_WATCH_INTERVAL_SEC
          )
        )
          continue;
        try {
          await runOnce(config);
        } catch (reason) {
          // 单台失败不能中断整轮 —— 后面的会话还在等这一拍
          logWarn(
            `[watch] 会话 ${config.sessionId} 巡检异常`,
            reason
          );
        }
      }
    },
    [runOnce]
  );

  /** 到期判断要读最新状态，但 tick 的依赖不能带状态（会反复重建监听）。 */
  useEffect(() => {
    statusesRef.current = statuses;
  }, [statuses]);

  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  // 订阅心跳：只在挂载时订一次，回调里读最新的 tickRef
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<{ at: number }>(TICK_EVENT, event => {
      void tickRef.current(
        Number(event.payload?.at) || Date.now()
      );
    })
      .then(handle => {
        // 订阅是异步的：组件已经卸载时立刻退订，否则监听会泄漏
        if (disposed) handle();
        else unlisten = handle;
      })
      .catch((reason: unknown) => {
        logWarn(
          "[watch] 订阅巡检心跳失败",
          reason
        );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 有启用的配置就开心跳，全关就停 —— 不留一个空转的定时器
  const activeCount = configs.filter(
    config => config.enabled
  ).length;
  useEffect(() => {
    if (activeCount === 0) {
      void invoke("watch_heartbeat_stop").catch(
        () => undefined
      );
      return;
    }
    invoke<number>("watch_heartbeat_start", {
      seconds: TICK_SEC
    })
      .then(interval => {
        console.info(
          `[watch] 心跳已启动（${interval} 秒），启用巡检的会话 ${activeCount} 个`
        );
      })
      .catch((reason: unknown) => {
        logWarn(
          "[watch] 启动巡检心跳失败",
          reason
        );
        errorRef.current?.(
          `值守心跳启动失败：${String(reason)}`
        );
      });
  }, [activeCount]);

  // 卸载即停心跳：留着一个没人处理 tick 的定时器纯属浪费
  useEffect(
    () => () => {
      void invoke("watch_heartbeat_stop").catch(
        () => undefined
      );
    },
    []
  );

  /** 手动「立即采样」：不等到期，点一下就跑。 */
  const runNow = useCallback(
    async (sessionId: string) => {
      const config = fileRef.current.configs.find(
        item => item.sessionId === sessionId
      );
      if (!config) {
        errorRef.current?.(
          "这个会话还没有巡检配置"
        );
        return;
      }
      console.info(
        `[watch] 手动触发巡检：${sessionId}`
      );
      await runOnce(config);
    },
    [runOnce]
  );

  const statusOf = useCallback(
    (sessionId: string): WatchStatus =>
      statuses[sessionId] ?? IDLE_STATUS,
    [statuses]
  );

  /**
   * 取某会话在时间窗内的采样（时间正序）。
   *
   * 班报与图表都从这里取，不要自己 filter `series` —— 存储是新在前、
   * 画图要正序，反转漏一次就是「图反着走」，而且看着还挺像正常的图。
   */
  const pointsIn = useCallback(
    (
      sessionId: string,
      from: number,
      to: number
    ) => pointsOf(series, sessionId, from, to),
    [series]
  );

  return {
    configs,
    alerts,
    series,
    statusOf,
    pointsIn,
    runNow,
    removeAlert,
    reload
  };
}

/** 采样原文留一份：事后归因要的就是「当时的现场」。 */
function toRecord(
  event: WatchEvent,
  sessionId: string,
  sessionName: string,
  sample: WatchSample
): WatchAlertRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    sessionName,
    kind: event.kind,
    level: event.level,
    value: event.value,
    threshold: event.threshold,
    subject: event.subject,
    at: Date.now(),
    detail: sample.raw.slice(0, 2000)
  };
}
