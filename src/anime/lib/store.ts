/**
 * 动漫播放配置存取：走用户数据目录（~/.tera-shell/anime.json）。
 *
 * 只存 API 域名这类配置；观看记录之类暂不落盘（YAGNI，要时再加字段）。
 */
import { invoke } from "@tauri-apps/api/core";

/** 数据文件的逻辑名（后端 ALLOWED 白名单里已注册）。 */
const DATA_NAME = "anime";

export type AnimeConfig = {
  /** 参考 App 的 API 域名（https://…），运行时解密下发所以由用户配置。 */
  baseUrl: string;
  /** 播放器音量（0..1）：跨会话记住上次的音量。 */
  volume?: number;
  /** 观看进度：剧 key（聚站 voddetail 路径 / 参考站 videoId）→ 最近一集与秒数。 */
  progress?: Record<string, WatchProgress>;
  /** 收藏（追番）：剧 key → 展示条目。 */
  favorites?: Record<string, FavoriteEntry>;
  /** 已完成的下载记录（下载页展示）。 */
  downloads?: DownloadedItem[];
  /** Bangumi 个人访问令牌（追番进度同步用，可选）。 */
  bgmToken?: string;
  /** 本地剧 key → Bangumi 条目 id（标题匹配成功后缓存，省重复搜索）。 */
  bgmLinks?: Record<string, number>;
  /** 弹弹play 开放 API 凭证（弹幕用，可选；api.dandanplay.net 申请）。 */
  danmuAppId?: string;
  danmuAppSecret?: string;
  /** 弹幕开关（播放器里切换后记住）。 */
  danmuOn?: boolean;
};

/** 一条已完成的下载记录。 */
export type DownloadedItem = {
  /** 成品文件的绝对路径 */
  path: string;
  /** 「剧名-集名」 */
  name: string;
  savedAt: number;
};

/** 一条观看进度（续播记忆）。 */
export type WatchProgress = {
  /** 剧名（继续观看栏展示用） */
  title: string;
  /** 海报（可缺省，缺了显示首字占位） */
  poster?: string;
  /** 数据源：juz 不存（key 即 voddetail 路径可判），app 线路必须存 */
  origin?: "app";
  /** 最近观看的集号 */
  epNum: number;
  /** 该集内的秒数（续播 seek 目标） */
  sec: number;
  /** 该集总时长（有的话，用于算「看完没」） */
  duration?: number;
  /** 最近观看时间戳（排序用） */
  updatedAt: number;
};

/** 一条收藏。 */
export type FavoriteEntry = {
  title: string;
  poster?: string;
  origin?: "app";
  addedAt: number;
};

const DEFAULT_CONFIG: AnimeConfig = {
  baseUrl: "",
  volume: 1
};

/** 读配置；文件缺失或损坏都退回默认（域名没配时弹层里有输入框）。 */
export async function loadAnimeConfig(): Promise<AnimeConfig> {
  const all =
    await invoke<
      Record<string, string | undefined>
    >("load_all");
  const raw = all[DATA_NAME];
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(
      raw
    ) as Partial<AnimeConfig>;
    return {
      baseUrl:
        typeof parsed.baseUrl === "string"
          ? parsed.baseUrl
          : "",
      volume:
        typeof parsed.volume === "number" &&
        parsed.volume >= 0 &&
        parsed.volume <= 1
          ? parsed.volume
          : 1,
      progress:
        parsed.progress &&
        typeof parsed.progress === "object"
          ? parsed.progress
          : {},
      favorites:
        parsed.favorites &&
        typeof parsed.favorites === "object"
          ? parsed.favorites
          : {},
      downloads: Array.isArray(parsed.downloads)
        ? parsed.downloads
        : [],
      bgmToken:
        typeof parsed.bgmToken === "string"
          ? parsed.bgmToken
          : "",
      bgmLinks:
        parsed.bgmLinks &&
        typeof parsed.bgmLinks === "object"
          ? parsed.bgmLinks
          : {},
      danmuAppId:
        typeof parsed.danmuAppId === "string"
          ? parsed.danmuAppId
          : "",
      danmuAppSecret:
        typeof parsed.danmuAppSecret === "string"
          ? parsed.danmuAppSecret
          : "",
      danmuOn: parsed.danmuOn !== false
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 覆盖保存下载记录列表（封顶 200 条，调用方负责去重）。 */
export async function saveDownloads(
  items: DownloadedItem[]
): Promise<void> {
  const config = await loadAnimeConfig();
  await saveAnimeConfig({
    ...config,
    downloads: items.slice(0, 200)
  });
}

/** 保存配置（整体覆盖写）。 */
export async function saveAnimeConfig(
  config: AnimeConfig
): Promise<void> {
  await invoke("save_one", {
    name: DATA_NAME,
    payload: JSON.stringify(config)
  });
}

/**
 * 更新一部剧的观看进度（读改写整体配置）。
 * 每剧一条、总量封顶 200 条（最旧的淘汰），防 anime.json 无限膨胀。
 */
export async function saveWatchProgress(
  key: string,
  entry: WatchProgress
): Promise<void> {
  const config = await loadAnimeConfig();
  const progress = {
    ...(config.progress ?? {})
  };
  progress[key] = entry;
  const keys = Object.keys(progress);
  if (keys.length > 200) {
    keys.sort(
      (a, b) =>
        (progress[a]?.updatedAt ?? 0) -
        (progress[b]?.updatedAt ?? 0)
    );
    for (const stale of keys.slice(
      0,
      keys.length - 200
    )) {
      delete progress[stale];
    }
  }
  await saveAnimeConfig({
    ...config,
    progress
  });
}

/** 切换收藏；返回切换后是否已收藏。 */
export async function toggleFavorite(
  key: string,
  entry: Omit<FavoriteEntry, "addedAt">
): Promise<boolean> {
  const config = await loadAnimeConfig();
  const favorites = {
    ...(config.favorites ?? {})
  };
  if (favorites[key]) {
    delete favorites[key];
    await saveAnimeConfig({
      ...config,
      favorites
    });
    return false;
  }
  favorites[key] = {
    ...entry,
    addedAt: Date.now()
  };
  await saveAnimeConfig({
    ...config,
    favorites
  });
  return true;
}
