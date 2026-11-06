/**
 * 弹弹play 弹幕拉取：设置里配了 AppId/AppSecret 才启用。
 *
 * 匹配用「剧名 + 集名」拼出的文件名（弹弹play 服务端做文本匹配），
 * 匹配不上 / 没配凭证 / 网络失败一律返回 null——弹幕是加分项，
 * 静默缺省，绝不打扰播放主流程。
 */
import { invoke } from "@tauri-apps/api/core";
import { loadAnimeConfig } from "@/anime/lib/store";
import { logError } from "@/shared/lib/log";

/** 一条弹幕（后端 danmu_comments 已解析 p 字段：秒/模式/颜色/文本）。 */
export type DanmuComment = {
  t: number;
  mode: number;
  color: number;
  text: string;
};

/** 弹弹play 匹配结果子集。 */
type DanmuMatch = {
  episodeId: number;
  animeTitle: string;
  episodeTitle: string;
};

/** 匹配用文件名：剧名 + 集标识（集名有就用集名，没有用「第N集」）。 */
export function danmuFileName(
  title: string,
  epNum: number,
  label?: string
): string {
  const ep = label?.trim() || `第${epNum}集`;
  return `${title} ${ep}`;
}

/** 弹弹play 模式 → danmaku 引擎模式（1-3 滚动、4 底部、5 顶部）。 */
export function danmuMode(
  mode: number
): "rtl" | "top" | "bottom" {
  if (mode === 5) return "top";
  if (mode === 4) return "bottom";
  return "rtl";
}

/** 弹幕颜色（ARGB 数值）→ CSS 颜色。 */
export function danmuColor(
  color: number
): string {
  return `#${(color & 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
}

/** 加载一集弹幕；失败/未配置返回 null。 */
export async function danmuLoad(
  title: string,
  epNum: number,
  label?: string
): Promise<DanmuComment[] | null> {
  try {
    const config = await loadAnimeConfig();
    const appId = config.danmuAppId?.trim();
    const appSecret =
      config.danmuAppSecret?.trim();
    if (!appId || !appSecret) return null;
    const fileName = danmuFileName(
      title,
      epNum,
      label
    );
    const match = await invoke<DanmuMatch | null>(
      "danmu_match",
      {
        appId,
        appSecret,
        fileName,
        epNum
      }
    );
    if (!match) return null;
    return await invoke<DanmuComment[]>(
      "danmu_comments",
      {
        appId,
        appSecret,
        fileName,
        episodeId: match.episodeId
      }
    );
  } catch (reason) {
    logError("[anime] 弹幕加载失败", reason);
    return null;
  }
}
