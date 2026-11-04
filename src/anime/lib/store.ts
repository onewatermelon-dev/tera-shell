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
          : 1
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
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
