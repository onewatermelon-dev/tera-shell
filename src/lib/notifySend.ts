/**
 * 通知的实际发送：把 `lib/notify.ts` 的判定结果弹成系统通知。
 *
 * 与 `notify.ts` 分开是因为职责不同：那边是**纯逻辑**（能不能发），
 * 这边是**副作用**（真的弹）。分开后判定逻辑可以脱离 Tauri 环境单测。
 *
 * ## ⚠️ 必须用原生插件，不能用 Web Notification API
 *
 * WebView2 的 `CoreWebView2ProfileSettings.AreHostNotificationsAllowed`
 * **默认是 false** —— `window.Notification` 在 Tauri 里虽然存在，宿主却
 * 不会真正弹系统通知，而 wry / Tauri v2 都没有暴露这个开关。
 * （2026-10-18 实测踩过：测试通知直接报「环境不支持」。）
 *
 * 所以走 `tauri-plugin-notification`，它由原生侧发通知，不受该开关限制。
 * 版本必须与 tauri 2.11 匹配，原因见 `Cargo.toml` 里的注释。
 */
import { logWarn } from "@/shared/lib/log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from "@tauri-apps/plugin-notification";
import {
  formatDuration,
  shouldNotify,
  type NotifyPayload
} from "@/lib/notify";
import type { AppSettings } from "@/settings/lib/settings";
import { COMMAND_THRESHOLD_MS } from "@/lib/notify";

/**
 * 通知提示音。
 *
 * ## 这里传的是「音效名」，不是文件路径 —— 插件文档在这一点上写错了
 *
 * `tauri-plugin-notification` 的 JSDoc 写着「On Windows: use file paths
 * to sound files (.wav format)」，**这是错的**。翻它的 Rust 实现
 * （tauri-winrt-notification）能看到：
 *
 * ```rust
 * // Sound::from_str 只认这几个名字
 * "Default" | "IM" | "Mail" | "Reminder" | "SMS" | LoopableSound(..)
 * // 最终拼进 toast XML 的是系统音效协议，而不是文件路径
 * xml_el.SetAttribute(h!("src"),
 *     &format!("ms-winsoundevent:Notification.{sound}").into())?;
 * ```
 *
 * WinRT 的 toast 只认 `ms-winsoundevent:` 协议的系统音效 ID，**给文件
 * 路径不会报错、只是静默不响** —— 正是踩过的坑（曾为此专门写了
 * `app_system_sound` 命令去探测 `C://Windows//Media//*.wav`，方向从根上
 * 就错了，已删除）。
 *
 * ## 另一个坑：**不传 sound 等于显式静音**
 *
 * 未设置声音时插件走 `else` 分支，写出
 * `<audio silent="true" />` —— 不是"用系统默认"，而是"明确静音"。
 * 所以想要声音**必须**传值，没有"留空则用默认"这种行为。
 */
const NOTIFY_SOUND = "IM";

/** 权限检查的结果，区分「不可用」与「被拒绝」——两者的修法完全不同。 */
export type PermissionOutcome =
  | { ok: true }
  | {
      ok: false;
      /** unsupported = 环境根本没有 Notification；denied = 用户拒绝过 */
      reason: "unsupported" | "denied";
    };

/**
 * 申请通知权限。
 *
 * 只在第一次真正要发通知时申请 —— 用户点了「启用通知」开关就立刻弹
 * 系统授权框会显得突兀，而等他第一次遇到长命令再问，语境自然得多。
 *
 * ⚠️ 返回值要区分「插件不可用」与「权限被拒绝」：前者是 `.plugin(...)`
 * 没注册或 capabilities 没放行 `notification:default`，后者是用户点过
 * 「拒绝」。混成一句话会让排查完全无从下手 —— 2026-10-18 就因此卡住过。
 */
export async function ensurePermission(): Promise<PermissionOutcome> {
  try {
    if (await isPermissionGranted())
      return { ok: true };
  } catch (reason) {
    // 命令不存在（插件没注册 / capability 没放行）会走到这里。
    // 这不是「用户拒绝」，必须如实区分，否则排查方向完全错
    logWarn(
      "[notify] 查询通知权限失败：插件可能未注册",
      reason
    );
    return { ok: false, reason: "unsupported" };
  }
  try {
    const result = await requestPermission();
    if (result !== "granted") {
      logWarn(
        "[notify] 用户未授予通知权限",
        result
      );
      return { ok: false, reason: "denied" };
    }
    return { ok: true };
  } catch (reason) {
    logWarn("[notify] 申请通知权限失败", reason);
    return { ok: false, reason: "denied" };
  }
}

/**
 * 主窗口当前是否聚焦。
 *
 * 取不到时**按「已聚焦」处理**：宁可少弹通知，也不要在用户正看着
 * 终端的时候糊他一脸 —— 误弹的代价比漏弹大得多。
 */
export async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch (reason) {
    logWarn(
      "[notify] 读窗口聚焦状态失败，按已聚焦处理",
      reason
    );
    return true;
  }
}

/**
 * 按设置与窗口状态决定是否发出通知。
 *
 * @param settings 当前设置（三类开关 + 总开关）
 * @param payload 通知内容
 * @param options.elapsedMs 耗时；命令类必填（用于比对阈值）
 * @returns 是否真的发出了通知（调试与测试用）
 */
export async function notify(
  settings: AppSettings,
  payload: NotifyPayload,
  options: { elapsedMs?: number } = {}
): Promise<boolean> {
  const kindEnabled =
    payload.kind === "command"
      ? settings.notifyCommand
      : payload.kind === "ai"
        ? settings.notifyAi
        : payload.kind === "watch"
          ? settings.notifyWatch
          : settings.notifyTransfer;
  const isFocused = await isWindowFocused();
  // ⚠️ 只构造**一份**判定数据，日志与判定都用它。
  // 曾写成「日志打criteria、判定打另一份（focused 还会取反）」，
  // 于是日志显示「窗口未聚焦」而实际传给判定的是「聚焦」——
  // 表现为明明四项都合格却被拦，排查时两个数字对不上，极难定位。
  // 单一数据源从结构上杜绝这种错位。
  const criteria = {
    enabled: settings.notifyEnabled,
    kindEnabled,
    // 直接传 isFocused，**不要取反**：shouldNotify 的 focused 语义就是
    // 「窗口当前是否聚焦」，内部 `if (focused) return false`。
    focused: isFocused,
    elapsedMs:
      payload.kind === "command"
        ? options.elapsedMs
        : undefined,
    thresholdMs:
      payload.kind === "command"
        ? COMMAND_THRESHOLD_MS
        : undefined
  };
  const allowed = shouldNotify(criteria);
  // ⚠️ 被拦下也要说清楚卡在哪一道 —— 「没弹」是个没有信息量的结果，
  // 四道闸门任一为 false 都会长这样，用户只能挨个猜（2026-10-18 踩过）。
  // 这里把四项原样打出来，看 Console 一眼就知道是开关没开、还是忘了切窗口。
  if (!allowed) {
    console.debug(
      `[notify] 已拦截（${payload.kind}）`,
      {
        总开关: criteria.enabled,
        分类开关: criteria.kindEnabled,
        窗口聚焦中: criteria.focused,
        耗时ms: criteria.elapsedMs,
        阈值ms: criteria.thresholdMs
      }
    );
    return false;
  }
  const permission = await ensurePermission();
  if (!permission.ok) {
    logWarn(
      `[notify] 通知被拒（${payload.kind}）`,
      permission.reason
    );
    return false;
  }
  try {
    sendNotification({
      title: payload.title,
      body: payload.body,
      sound: NOTIFY_SOUND
    });
    console.info(
      "[notify] 已发出通知",
      payload.kind,
      payload.title
    );
    return true;
  } catch (reason) {
    // 通知发不出去绝不能影响主流程（AI 回复已经产出、传输已经完成）
    logWarn("[notify] 发送通知失败", reason);
    return false;
  }
}

/** 长命令跑完的通知内容。 */
export function commandNotification(
  command: string,
  elapsedMs: number
): NotifyPayload {
  const duration = formatDuration(elapsedMs);
  // 取不到命令文本时（回车瞬间远端尚未回显）只报耗时，
  // 别显示成 " · 11 秒" 这种半截话
  return {
    kind: "command",
    title: "命令已完成",
    body: command
      ? // 命令可能很长，取尾部更接近用户关心的部分（终端里也这样显示）
        `${truncate(command)} · ${duration}`
      : duration
  };
}

/** AI 回答完成的通知内容。 */
export function aiNotification(
  modelName: string,
  elapsedMs: number,
  preview: string
): NotifyPayload {
  return {
    kind: "ai",
    title: "AI 回答完成",
    // 模型名要带上：同时跑多个会话时，用户靠名字认得出是哪个
    body: preview
      ? `${modelName} · ${truncate(preview)}`
      : `${modelName} · ${formatDuration(elapsedMs)}`
  };
}

/** 传输结束的通知内容。 */
export function transferNotification(
  summary: string,
  succeeded: boolean
): NotifyPayload {
  return {
    kind: "transfer",
    title: succeeded ? "传输完成" : "传输失败",
    body: summary
  };
}

/**
 * 值守巡检的通知内容。
 *
 * 标题按「告警 / 已恢复」分开，是为了让人**在通知中心里一眼扫过去**就
 * 知道当前是变坏还是变好 —— 一晚上十几条通知，标题长得一样等于没有标题。
 *
 * @param summary 已由 `describeEvent` 拼好的正文（会话名 + 指标 + 阈值）
 * @param level 告警还是恢复
 * @param repeat 冷却后的重复提醒（「仍未恢复」）
 */
export function watchNotification(
  summary: string,
  level: "alert" | "recover",
  repeat = false
): NotifyPayload {
  return {
    kind: "watch",
    title:
      level === "recover"
        ? "值守 · 已恢复"
        : repeat
          ? "值守 · 仍未恢复"
          : "值守 · 告警",
    body: summary
  };
}

/** 把过长的一行文字截到通知可读的长度。 */
function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 80
    ? clean
    : `${clean.slice(0, 79)}…`;
}
