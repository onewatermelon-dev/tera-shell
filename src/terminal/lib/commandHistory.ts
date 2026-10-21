/**
 * 命令历史：按主机隔离的条目存储与检索。
 *
 * ## 为什么必须隔离
 *
 * 早先的历史是一个全局字符串数组（「全部终端共享」，仿 PSReadLine 的
 * 全局历史）。在**个人单机**上这没问题，但对运维是危险的默认值：
 * 在生产机提示符上补全时，ghost text 可能给你补出测试机上的
 * `rm -rf /data` —— 运维最常见的误操作就是「这台机器上一条命令是什么
 * 来着」，而一条看起来熟悉的命令恰好来自另一台机器。
 *
 * 所以条目带主机标识，**补全只用当前主机的历史**。
 *
 * ## 代价（刻意的取舍）
 *
 * 升级前存的是纯字符串数组，没有主机信息。迁移时把这些条目的 `host`
 * 记为 `""`（未知来源）：
 * - **不参与补全** —— 否则隔离等于没做，生产机上照样能补出测试机的命令；
 * - 但**保留在检索面板里**（标为「历史遗留」），用户可以手动挑出来用。
 *
 * 新机器头几条命令没有建议是正常的，用一次就有了。
 *
 * ## 落盘
 *
 * 仍是 `command_history.json` 一个文件（`DataName.commandHistory`），
 * 上限 5000 条。写入是「内存先行 + 异步落盘」，`Snapshot` 随时可读。
 */
import type { SavedSession } from "@/sessions/lib/session";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/** 一条历史记录。 */
export type CommandHistoryEntry = {
  /** 命令原文（已去首尾空白） */
  cmd: string;
  /**
   * 主机标识，见 `hostKeyOf`；空串 = 升级前的历史遗留（来源未知）。
   */
  host: string;
  /** 记录时间（毫秒时间戳）；历史遗留为 0。 */
  at: number;
  /** 退出码；没有 shell 集成、或命令已被覆盖时为 null。 */
  exitCode: number | null;
};

/** 历史上限：超出后丢最旧的（5000 条约 400KB，仍是一次全量写的可接受量）。 */
export const HISTORY_LIMIT = 5000;

/** 本地会话在历史里的主机标识。 */
export const LOCAL_HOST = "local";

/**
 * 会话的主机标识：`user@host:port`，本地会话固定 `local`。
 *
 * 用「用户 + 主机 + 端口」而不是 host 一项：同一台机器上的 root 与
 * deploy 能跑的命令完全不同，日常会话与测试会话也常用不同端口。
 *
 * @param session 会话定义（只取连接相关字段）
 */
export function hostKeyOf(
  session: Pick<
    SavedSession,
    "kind" | "host" | "port" | "username"
  >
): string {
  if (session.kind !== "ssh" || !session.host)
    return LOCAL_HOST;
  const user = session.username
    ? `${session.username}@`
    : "";
  return `${user}${session.host}:${session.port}`;
}

/** 主机标识的人类可读形式（面板里显示用）。 */
export function hostLabelOf(
  host: string
): string {
  if (!host) return "历史遗留";
  if (host === LOCAL_HOST) return "本地";
  return host;
}

/** 缓存：内存里的当前历史（时间正序，最新在末尾）。 */
let cache: CommandHistoryEntry[] | null = null;

/**
 * 版本号：每次写入 +1，供上层判断「按主机缓存的命令列表过期了没」。
 *
 * 补全每次输出解析都会取一次当前主机的命令列表，5000 条全量过滤撑不住
 * 那种频率（每秒几十次），所以要能廉价地判断缓存是否还有效。
 */
let version = 0;

/** 当前历史版本号。 */
export function historyVersion(): number {
  return version;
}

/** 判断一个值是否是合法的条目。 */
function isEntry(
  value: unknown
): value is CommandHistoryEntry {
  if (!value || typeof value !== "object")
    return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.cmd === "string" &&
    typeof entry.host === "string" &&
    typeof entry.at === "number" &&
    (entry.exitCode === null ||
      typeof entry.exitCode === "number")
  );
}

/**
 * 迁移 + 清洗：兼容旧的 `string[]` 格式，丢掉坏数据，按上限截断。
 *
 * @param raw 解析后的 JSON
 */
export function normalizeHistory(
  raw: unknown
): CommandHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: CommandHistoryEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const cmd = item.trim();
      // 旧格式没有主机信息：host 记空串（不参与补全，见文件头）
      if (cmd)
        entries.push({
          cmd,
          host: "",
          at: 0,
          exitCode: null
        });
      continue;
    }
    if (!isEntry(item)) continue;
    const cmd = item.cmd.trim();
    if (!cmd) continue;
    entries.push({ ...item, cmd });
  }
  return entries.slice(-HISTORY_LIMIT);
}

/** 读历史（首次从存储加载，之后命中缓存）。 */
export function loadHistory(): CommandHistoryEntry[] {
  if (cache) return cache;
  try {
    const raw = readData(DataName.commandHistory);
    cache = raw
      ? normalizeHistory(JSON.parse(raw))
      : [];
  } catch (reason) {
    // 历史丢了不致命，不能让终端区因此挂掉
    console.warn(
      "[history] 命令历史读取失败",
      reason
    );
    cache = [];
  }
  return cache;
}

/** 写回（内存先行；版本号递增让补全的按主机缓存失效）。 */
function persist(
  entries: CommandHistoryEntry[]
): void {
  cache = entries;
  version += 1;
  writeData(
    DataName.commandHistory,
    JSON.stringify(entries)
  );
}

/**
 * 追加一条命令：同主机同命令去重后挪到末尾，超出上限丢最旧。
 *
 * 纯函数，返回新数组（便于单测）。
 *
 * @param list 现有条目（时间正序）
 * @param entry 新条目
 * @param limit 上限
 */
export function appendEntry(
  list: CommandHistoryEntry[],
  entry: CommandHistoryEntry,
  limit = HISTORY_LIMIT
): CommandHistoryEntry[] {
  const rest = list.filter(
    item =>
      !(
        item.host === entry.host &&
        item.cmd === entry.cmd
      )
  );
  const next = [...rest, entry];
  return next.length > limit
    ? next.slice(-limit)
    : next;
}

/**
 * 给该主机「最近一条还没有退出码」的记录回填退出码。
 *
 * 时序上这是必然的：命令在 `C` 标记处就记进历史了（那时文本已确定），
 * 退出码要等 `D` 标记才拿得到。
 *
 * 找不到目标（例如用户只是空回车，或没有 shell 集成）时**返回原数组**，
 * 调用方据此跳过落盘 —— 每次输出都重写 5000 条不值得。
 *
 * @param list 现有条目
 * @param host 主机标识
 * @param code 退出码
 */
export function markExitCode(
  list: CommandHistoryEntry[],
  host: string,
  code: number
): CommandHistoryEntry[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (!entry || entry.host !== host) continue;
    if (entry.exitCode !== null) continue;
    const next = list.slice();
    next[i] = { ...entry, exitCode: code };
    return next;
  }
  return list;
}

/** 记录一条命令（写入内存 + 落盘）。 */
export function recordCommand(
  cmd: string,
  host: string,
  at = Date.now()
): void {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  persist(
    appendEntry(loadHistory(), {
      cmd: trimmed,
      host,
      at,
      exitCode: null
    })
  );
}

/** 回填退出码（无匹配时不写盘）。 */
export function recordExitCode(
  host: string,
  code: number
): void {
  const list = loadHistory();
  const next = markExitCode(list, host, code);
  if (next !== list) persist(next);
}

/**
 * 取某主机的命令列表（时间正序），供补全建议用。
 *
 * 严格按主机过滤：未知来源（`host === ""`）的旧条目**不参与**。
 *
 * @param list 全部条目
 * @param host 当前会话的主机标识
 */
export function commandsOfHost(
  list: CommandHistoryEntry[],
  host: string
): string[] {
  const out: string[] = [];
  for (const entry of list) {
    if (entry.host === host) out.push(entry.cmd);
  }
  return out;
}

/**
 * 检索：模糊匹配（子串，大小写不敏感），按时间**倒序**返回。
 *
 * @param list 全部条目
 * @param query 关键词；空串表示不过滤
 * @param host 仅搜该主机；缺省/空串表示跨主机
 */
export function searchEntries(
  list: CommandHistoryEntry[],
  query: string,
  host?: string
): CommandHistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const out: CommandHistoryEntry[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (!entry) continue;
    if (host && entry.host !== host) continue;
    if (
      needle &&
      !entry.cmd.toLowerCase().includes(needle)
    )
      continue;
    out.push(entry);
  }
  return out;
}

/** 当前历史的快照（面板打开时读一次）。 */
export function historySnapshot(): CommandHistoryEntry[] {
  return loadHistory();
}

/**
 * 清空历史（测试或将来「设置页一键清除」用）。
 *
 * @param host 只清该主机；缺省清全部
 */
export function clearHistory(
  host?: string
): void {
  if (!host) {
    persist([]);
    return;
  }
  persist(
    loadHistory().filter(e => e.host !== host)
  );
}
