/**
 * 播放地址提取：resolve/sign 与 resolve/exchange 的响应里挖直链。
 *
 * 参考 App 的解析链有两档：服务端直接给 playUrl（常规源），或下发
 * luaScript/clientScript 让 App 内嵌 Lua 引擎现场解析（TVBox 式站点解析）。
 * 本工具不做 Lua 解析——那种源标记 clientParse=true 由 UI 明示。
 */
import type { ResolvedPlay } from "@/anime/lib/types";

/** 直链字段的候选键名，按优先级排（main_play_url 是 TTVideoEngine 口径）。
 *  ⚠️ originalUrl 故意不在表里：那是 Lua 解析源的「网页地址」，不是流地址。 */
const URL_KEYS = [
  "play_url",
  "playUrl",
  "main_play_url",
  "url",
  "backup_play_url"
] as const;

/** Lua 客户端解析的标志键：出现即说明直链要本地跑脚本才有。 */
function isClientParseSource(
  data: Record<string, unknown>
): boolean {
  const hasScript = (value: unknown) =>
    typeof value === "string" && value.length > 0;
  return (
    data.isClientParse === true ||
    data.isClientParse === "true" ||
    hasScript(data.luaScript) ||
    hasScript(data.clientScript) ||
    hasScript(data.fallbackLuaScript)
  );
}

/** 判定值是不是「能播的 URL 文本」（过滤空串/对象/数字等）。 */
function playableUrl(
  value: unknown
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // http(s) 起步才算直链；别的值（占位/空）不算
  if (/^https?:\/\//.test(trimmed))
    return trimmed;
  return null;
}

/** 递归找第一个可播 URL：对象里按 URL_KEYS 优先，最多下探 3 层。 */
function findUrl(
  data: unknown,
  depth: number
): string | null {
  if (depth > 3) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (data !== null && typeof data === "object") {
    const record = data as Record<
      string,
      unknown
    >;
    for (const key of URL_KEYS) {
      const direct = playableUrl(record[key]);
      if (direct) return direct;
    }
    // 主键没中再翻嵌套（qualities 数组、playInfo 包一层等）
    for (const value of Object.values(record)) {
      const found = findUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 从 resolve 响应的 data（或 exchange 响应本身）提播放信息。
 *
 * 找不到直链且带 Lua 标记 → clientParse=true；都没有 → url=null
 * （UI 显示「拿不到播放地址」而不是瞎猜）。
 */
export function extractPlay(
  data: unknown
): ResolvedPlay {
  const record =
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const clientParse = isClientParseSource(record);
  const url = findUrl(record, 0);
  const quality =
    typeof record.quality === "string"
      ? record.quality
      : undefined;
  return { url, clientParse, quality };
}
