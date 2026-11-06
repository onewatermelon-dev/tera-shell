/**
 * Bangumi（bgm.tv）开放 API 客户端：放送日历、条目匹配与追番进度同步。
 *
 * 网络统一走后端 `bgm_fetch` 命令（官方要求可识别 User-Agent，WebView 里
 * 改不了这个头，CORS 也不受我们控制）。这里只负责拼路径、解析 JSON，以及
 * 「宁可不同步也不同步错」的标题匹配策略：只有站内中文名/原名与本地剧名
 * （去季标后）完全一致才认，认不出就不显示评分、不同步进度。
 */
import { invoke } from "@tauri-apps/api/core";
import { logError } from "@/shared/lib/log";

/** 条目展示子集（接口字段已按用到的裁剪）。 */
export type BgmSubjectLite = {
  id: number;
  /** 原名（日文） */
  name: string;
  /** 中文名 */
  nameCn: string;
  /** 评分（1 位小数）；日历接口不带，详情接口才有 */
  score: number | null;
  summary: string;
  /** 海报（medium 尺寸，日历网格够用） */
  image: string;
};

/** 放送日历的一组：星期 + 当天放送的条目。 */
export type BgmCalendarGroup = {
  weekdayCn: string;
  /** 是否今天（高亮用） */
  isToday: boolean;
  items: BgmSubjectLite[];
};

/** 一次 Bangumi 请求；2xx 之外统一抛错（4xx 带上服务端 message）。 */
async function bgmRequest(
  path: string,
  options?: {
    method?: "GET" | "POST" | "PUT";
    token?: string;
    body?: unknown;
  }
): Promise<unknown> {
  const response = await invoke<{
    status: number;
    body: string;
  }>("bgm_fetch", {
    method: options?.method ?? "GET",
    path,
    token: options?.token ?? null,
    body: options?.body ?? null
  });
  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    let message = `Bangumi 返回 HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(
        response.body
      ) as {
        message?: string;
      };
      if (parsed.message)
        message += `：${parsed.message}`;
    } catch {
      // 错误体不是 JSON 就只报状态码
    }
    throw new Error(message);
  }
  return JSON.parse(response.body) as unknown;
}

/** 接口条目 → 展示子集（字段名对不上就给缺省，不猜）。 */
function toLite(
  raw: Record<string, unknown>
): BgmSubjectLite {
  const images = raw.images as
    Record<string, string> | undefined;
  return {
    id: Number(raw.id) || 0,
    name: String(raw.name ?? ""),
    nameCn: String(raw.name_cn ?? ""),
    score:
      typeof (raw.rating as { score?: number })
        ?.score === "number"
        ? (raw.rating as { score: number }).score
        : null,
    summary: String(raw.summary ?? ""),
    image: images?.medium ?? images?.common ?? ""
  };
}

/**
 * 摘掉标题里的季标与杂讯，得到用于比对的核心剧名。
 * 「葬送的芙莉莲 第二季」「斗罗大陆【国语】」→「葬送的芙莉莲」「斗罗大陆」。
 */
export function cleanSubjectTitle(
  title: string
): string {
  return (
    title
      // 【国语】/[2024] 这类标签整段摘掉
      .replace(/[【[][^】\]]*[】\]]/g, " ")
      // 第N季/第N部连同后面可能跟的季名一起摘掉
      .replace(
        /第[0-9一二三四五六七八九十]+[季部].*$/u,
        ""
      )
      // 结尾的年份括号（（2024）/ (2024)）
      .replace(/[（(]\s*\d{4}\s*[）)]$/u, "")
      .replace(/[\s·・—_:：（）()-]+$/u, "")
      .trim()
  );
}

/**
 * 从搜索结果里挑「确信同一部」的条目：站内中文名/原名与本地剧名
 * （原文或去季标后）完全一致才认。模糊包含不认——「鬼灭之刃」会撞上
 * 「鬼灭之刃 锻刀村篇」这种独立条目，认错了会污染追番记录。
 */
export function pickSubject(
  hits: Record<string, unknown>[],
  title: string
): BgmSubjectLite | null {
  const cleaned = cleanSubjectTitle(title);
  const equal = (a: string, b: string) =>
    a.trim() === b.trim();
  for (const raw of hits) {
    const lite = toLite(raw);
    if (
      equal(lite.nameCn, title) ||
      equal(lite.name, title) ||
      (cleaned &&
        (equal(lite.nameCn, cleaned) ||
          equal(lite.name, cleaned)))
    ) {
      return lite;
    }
  }
  return null;
}

/** 标题 → 条目 的会话内缓存（同一次弹层里反复进详情不重复请求）。 */
const subjectCache = new Map<
  string,
  BgmSubjectLite | null
>();

/** subjectId → (集号 → Bangumi 集条目 id) 的会话内缓存。 */
const episodeCache = new Map<
  number,
  Map<number, number>
>();

/** 已确保建过「在看」收藏的 subjectId（每会话每条目只打一次收藏请求）。 */
const collected = new Set<number>();

/**
 * 按标题找 Bangumi 条目：先拿原句搜，认不出再拿去季标剧名搜一次。
 * 都认不出返回 null（调用方静默跳过评分与同步）。
 */
export async function bgmFindSubject(
  title: string
): Promise<BgmSubjectLite | null> {
  const key = title.trim();
  if (subjectCache.has(key)) {
    return subjectCache.get(key) ?? null;
  }
  const trySearch = async (keyword: string) => {
    const data = (await bgmRequest(
      "/v0/search/subjects",
      {
        method: "POST",
        body: {
          keyword,
          filter: { type: [2] }
        }
      }
    )) as { data?: Record<string, unknown>[] };
    return pickSubject(data.data ?? [], title);
  };
  // 无初始化：try 里必有赋值，catch 路径直接 return（no-useless-assignment）
  let hit: BgmSubjectLite | null;
  try {
    hit = await trySearch(key);
    if (!hit) {
      const cleaned = cleanSubjectTitle(key);
      if (cleaned && cleaned !== key) {
        hit = await trySearch(cleaned);
      }
    }
  } catch (reason) {
    // Bangumi 挂了/网络不通：评分与同步整体静默，不影响播放主流程
    logError("[anime] Bangumi 搜索失败", reason);
    subjectCache.set(key, null);
    return null;
  }
  // 搜索结果不带评分，认中后再补一次详情（也进缓存）
  if (hit && hit.score === null) {
    try {
      const full = toLite(
        (await bgmRequest(
          `/v0/subjects/${hit.id}`
        )) as Record<string, unknown>
      );
      hit = { ...hit, ...full, id: hit.id };
    } catch (reason) {
      logError(
        "[anime] Bangumi 详情获取失败",
        reason
      );
    }
  }
  subjectCache.set(key, hit);
  return hit;
}

/** 拉每日放送日历（公开接口，无需令牌）。 */
export async function bgmCalendar(): Promise<
  BgmCalendarGroup[]
> {
  const raw = (await bgmRequest(
    "/calendar"
  )) as Array<{
    weekday?: {
      cn?: string;
      en?: string;
      id?: number;
    };
    items?: Record<string, unknown>[];
  }>;
  // API 的 weekday.id 1=周一…7=周日，与 Date.getDay()（0=周日）对齐换算今天
  const today = new Date().getDay();
  const todayId = today === 0 ? 7 : today;
  return raw.map(group => ({
    weekdayCn: group.weekday?.cn ?? "",
    isToday: group.weekday?.id === todayId,
    items: (group.items ?? [])
      .map(toLite)
      .filter(item => item.id > 0)
  }));
}

/** 拿一部的「集号 → Bangumi 集条目 id」映射（会话内缓存）。 */
async function episodeMap(
  subjectId: number
): Promise<Map<number, number>> {
  const cached = episodeCache.get(subjectId);
  if (cached) return cached;
  const data = (await bgmRequest(
    `/v0/subjects/${subjectId}/episodes`
  )) as {
    data?: Array<{
      id?: number;
      ep?: number | string;
      sort?: number | string;
    }>;
  };
  const map = new Map<number, number>();
  for (const ep of data.data ?? []) {
    const id = Number(ep.id);
    // sort 是带小数的序号（1.5 = SP 集），整集才参与匹配
    const num = Math.round(
      Number(ep.sort ?? ep.ep)
    );
    if (id > 0 && Number.isFinite(num)) {
      map.set(num, id);
    }
  }
  episodeCache.set(subjectId, map);
  return map;
}

/** 确保条目在「在看」收藏里（每会话每条目最多发一次请求）。 */
async function ensureCollecting(
  token: string,
  subject: BgmSubjectLite
): Promise<void> {
  if (collected.has(subject.id)) return;
  collected.add(subject.id);
  try {
    await bgmRequest(
      `/v0/users/-/collections/${subject.id}`,
      {
        method: "POST",
        token,
        // type 3 = 在看
        body: { type: 3 }
      }
    );
  } catch (reason) {
    logError(
      "[anime] Bangumi 收藏同步失败",
      reason
    );
  }
}

/** 收藏本地剧时把对应条目挂到「在看」（匹配不上条目就静默）。 */
export async function bgmCollect(
  token: string,
  title: string
): Promise<void> {
  const subject = await bgmFindSubject(title);
  if (subject)
    await ensureCollecting(token, subject);
}

/**
 * 追番进度同步（fire-and-forget 用）：确保条目在「在看」收藏里，
 * 并把看完（≥90%，时长未知则看满 15 分钟）的那一集标成「看过」。
 *
 * 没配令牌 / 匹配不上条目 / 任一请求失败都静默跳过——同步是加分项，
 * 绝不能打扰看片主流程。
 */
export async function bgmSyncProgress(input: {
  /** 个人访问令牌（anime.json 的 bgmToken） */
  token: string;
  /** 本地剧 key（bgmLinks 缓存的键） */
  key: string;
  title: string;
  epNum: number;
  sec: number;
  duration?: number;
}): Promise<void> {
  const done =
    input.duration != null && input.duration > 0
      ? input.sec / input.duration >= 0.9
      : input.sec >= 900;
  if (!done) return;
  const subject = await bgmFindSubject(
    input.title
  );
  if (!subject) return;
  // 打点请求失败不影响已看标记，反过来也一样：两步各自吞错
  try {
    const episodeId = (
      await episodeMap(subject.id)
    ).get(input.epNum);
    if (episodeId) {
      await bgmRequest(
        `/v0/users/-/collections/${subject.id}/episodes/${episodeId}`,
        {
          method: "POST",
          token: input.token,
          // type 2 = 看过
          body: { type: 2 }
        }
      );
    }
  } catch (reason) {
    // 集表没这一集（SP/剧场版编号对不上）也落在这里，静默
    logError("[anime] Bangumi 打点失败", reason);
  }
  await ensureCollecting(input.token, subject);
}
