/**
 * 动漫播放的数据模型：与参考 App（com.yy.myuko）逆向出的 API 结构对齐。
 *
 * 字段名即接口 JSON 字段（camelCase）；可选字段是 App 里存在但部分
 * 数据源不回的，前端一律按缺省处理，不猜。
 */

/** 接口通用包装：success=false 时 message 是服务端给的失败原因。 */
export type ApiEnvelope = {
  success?: boolean;
  message?: string;
};

/** 首页模块/搜索结果里的视频条目（HomeVideo）。 */
export type AnimeVideo = {
  id: string;
  title: string;
  subTitle?: string;
  coverUrl?: string;
  posterUrl?: string;
  totalEpisodes?: number;
  currentEpisodes?: number;
  isFinished?: boolean;
  updateSchedule?: string;
  score?: string | number;
  tags?: string;
  badgeTag?: string;
};

/** 首页模块（RecommendationResult）。 */
export type AnimeModule = {
  title: string;
  videos?: AnimeVideo[];
  hasMore?: boolean;
  pageInfo?: Record<string, unknown> | null;
};

/** 详情响应的完整视频实体（VideoInfoApiItem 的展示子集）。 */
export type AnimeDetail = AnimeVideo & {
  categoryId?: string;
  categoryName?: string;
  types?: string;
  area?: string;
  language?: string;
  year?: string | number;
  director?: string;
  actors?: string;
  description?: string;
  playCount?: number;
  collectCount?: number;
  vipLevel?: number;
};

/** 剧集条目（EpisodeApiItem）：sourceId 在播放入口用不到时可缺省。 */
export type AnimeEpisode = {
  episodeNum: number;
  episodeName?: string;
  duration?: number;
  sourceId?: string;
  code?: string;
};

/** 解析出的可播地址：clientParse=true 表示该源要 App 内嵌 Lua 解析，播不了。 */
export type ResolvedPlay = {
  url: string | null;
  clientParse: boolean;
  quality?: string;
};
