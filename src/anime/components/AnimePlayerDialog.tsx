/**
 * 动漫播放弹层：聚站浏览（频道/筛选/搜索）→ 详情页 → 播放器。
 *
 * 参考站（com.yy.myuko 逆向的加密 API，见 src-tauri/src/anime.rs）已并入聚站：
 * 浏览面只有聚站；进详情页时后台按标题在参考站搜同名视频，命中就把它的剧集
 * 作为「优选线路」插到线路列表最前（域名没配/接口挂了都静默跳过）。
 * 播放按线路来源分流：优选线路走 anime_play 播放链，聚站线路走网页解析。
 *
 * 播放：resolve 给的直链交给播放器；.m3u8 走 hls.js 动态加载
 * （WebView2 是 Chromium 内核，原生不认 HLS）。带 Lua 客户端解析的源
 * 不支持，明确报错不装死。
 *
 * 播放器本体拆在 VideoPlayer（直链/hls.js）与 TranscodePlayer（H.265 软解），
 * 共用 CinemaControls 的腾讯视频风格控制栏。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { Button, Modal } from "@heroui/react";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  DownloadOutlined,
  HeartFilled,
  HeartOutlined,
  LeftOutlined,
  RightOutlined
} from "@ant-design/icons";
import { EP_PAGE_SIZE } from "@/anime/components/CinemaControls";
import { useT } from "@/settings/lib/i18n";
import { logError } from "@/shared/lib/log";
import {
  animeApi,
  ENDPOINTS
} from "@/anime/lib/client";
import TranscodePlayer from "@/anime/components/TranscodePlayer";
import VideoPlayer from "@/anime/components/VideoPlayer";
import type { CinemaQualityOption } from "@/anime/components/CinemaControls";
import {
  loadAnimeConfig,
  saveAnimeConfig,
  saveDownloads,
  saveWatchProgress,
  toggleFavorite
} from "@/anime/lib/store";
import type {
  DownloadedItem,
  FavoriteEntry,
  WatchProgress
} from "@/anime/lib/store";
import { listen } from "@tauri-apps/api/event";
import {
  isDirectPlayUrl,
  juzDetail,
  juzHome,
  juzListing,
  juzPlay,
  juzResolveToken,
  juzSearch
} from "@/anime/lib/juz";
import type {
  JuzLine,
  JuzNavItem,
  JuzScreenGroup,
  JuzSection
} from "@/anime/lib/juz";
import type {
  AnimeDetail,
  AnimeEpisode,
  AnimeModule,
  AnimeVideo,
  ApiEnvelope
} from "@/anime/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  bgmCalendar,
  bgmCollect,
  bgmFindSubject,
  bgmSyncProgress
} from "@/anime/lib/bangumi";
import type {
  BgmCalendarGroup,
  BgmSubjectLite
} from "@/anime/lib/bangumi";
import { danmuLoad } from "@/anime/lib/danmu";
import type { DanmuComment } from "@/anime/lib/danmu";

/** 弹层数据面：模块列表（首页）或搜索结果，二选一展示。 */
type BrowseData = {
  modules: AnimeModule[];
  videos: AnimeVideo[];
};

/** 参考站合并线路在界面上显示的自定义名（区别于聚站站方的营销线路名）。 */
const APP_LINE_NAME = "优选线路";

/** 卡片图：poster 优先（竖版海报，动漫站惯例），cover 兜底。 */
function coverOf(video: AnimeVideo): string {
  return video.posterUrl || video.coverUrl || "";
}

/** 相对时间文案（继续观看/收藏列表用）。 */
function timeAgo(stamp: number): string {
  const delta = Date.now() - stamp;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (delta < min) return "刚刚";
  if (delta < hour)
    return `${Math.floor(delta / min)} 分钟前`;
  if (delta < day)
    return `${Math.floor(delta / hour)} 小时前`;
  return `${Math.floor(delta / day)} 天前`;
}

/**
 * 筛选组一行：chips 横向滚动（只显示一行）。
 * 右缘放不下的 chip 整只裁掉（clip-path 硬切，行尾永远只见完整按钮），
 * 滚动/换页后重算——滚到它时自然完整显示。
 */
function ScreenStrip({
  label,
  options,
  activePath,
  busy,
  onPick
}: {
  label: string;
  options: JuzNavItem[];
  activePath: string;
  busy: boolean;
  onPick: (opt: JuzNavItem) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(
    null
  );

  /** 直接写 style 不走 state：滚动事件高频，避免整行重渲染 */
  const updateClip = () => {
    const el = stripRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let cut = 0;
    for (const node of Array.from(el.children)) {
      const box = node.getBoundingClientRect();
      // +1 容差：正好贴边的不算溢出
      if (box.right > rect.right + 1) {
        // 裁切线放在这只 chip 左缘外 6px（间隙宽），整只不可见
        cut = rect.right - box.left + 6;
        break;
      }
    }
    el.style.clipPath =
      cut > 0 ? `inset(0 ${cut}px 0 0)` : "";
  };

  // 挂载/内容变化后先算一次（选项数不同，溢出情况不同）
  useEffect(() => {
    updateClip();
  });

  return (
    <div className="anime-screen-row">
      <span className="anime-screen-label">
        {label}
      </span>
      <div
        ref={stripRef}
        className="anime-screen-strip"
        onScroll={updateClip}
      >
        {options.map(opt => (
          <button
            key={opt.path}
            type="button"
            className={
              "anime-line-chip" +
              (activePath === opt.path
                ? " is-active"
                : "")
            }
            disabled={busy}
            onClick={() => onPick(opt)}
          >
            {opt.title}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AnimePlayerDialog({
  onClose
}: {
  onClose: () => void;
}) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState("");
  const [browse, setBrowse] =
    useState<BrowseData | null>(null);
  const [detail, setDetail] =
    useState<AnimeDetail | null>(null);
  const [episodes, setEpisodes] = useState<
    AnimeEpisode[]
  >([]);
  /** 聚站：频道导航（首页 nav 的分类链接） */
  const [juzNav, setJuzNav] = useState<
    JuzNavItem[]
  >([]);
  /** 聚站：当前列表页路径（"" = 首页） */
  const [juzPath, setJuzPath] = useState("");
  /** 聚站：当前列表页的筛选组（分类页才有） */
  const [juzScreens, setJuzScreens] = useState<
    JuzScreenGroup[]
  >([]);
  /** 聚站：首页板块（题材分区，各板块几张图） */
  const [juzSections, setJuzSections] = useState<
    JuzSection[]
  >([]);
  /** 聚站：详情页解析出的全部播放线路（dujia* 解析源混在其中） */
  const [juzLines, setJuzLines] = useState<
    JuzLine[]
  >([]);
  /** 当前选中的线路下标（用户可切换；播放探测命中后也会更新） */
  const [juzLineIdx, setJuzLineIdx] = useState(0);
  /**
   * 当前选中线路若来自参考站，存它的 videoId（播放走加密 API 链）；
   * 聚站线路为 null。随线路点击/详情切换同步。
   */
  const [appLineId, setAppLineId] = useState<
    string | null
  >(null);
  /** 用户是否手动点过线路：参考站线路异步合并回来时别覆盖用户的选择 */
  const lineTouched = useRef(false);
  /** 上次会话的音量（anime.json），新播放器起播时应用 */
  const [savedVolume, setSavedVolume] =
    useState(1);
  /** 详情页选集分页：每页 30 集，页签一行（箭头只平移页签条，不改选中页） */
  const [epPage, setEpPage] = useState(0);
  const epTabsRef = useRef<HTMLDivElement | null>(
    null
  );
  /** 音量写盘防抖：拖滑杆/滚轮高频触发，300ms 收口一次 */
  const volumeSaveTimer = useRef<number | null>(
    null
  );
  const [query, setQuery] = useState("");
  /** 本次播放已试过的清晰度（视频轨解不出时逐档回退，避免死循环） */
  const triedQualities = useRef<string[]>([]);
  /** H.265 片源走软解（ffmpeg 转码 + MSE） */
  const [softDecode, setSoftDecode] =
    useState(false);
  /** 本机是否有可用 ffmpeg（决定软解能不能开） */
  const [ffmpegReady, setFfmpegReady] =
    useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<{
    url: string;
    label: string;
    /** 当前清晰度 key（切换时高亮用） */
    quality: string;
    /** 这个源可选的清晰度，切档要整条链路重跑 */
    qualities: CinemaQualityOption[];
    /** 本条线路的视频编码（H265 时 WebView2 可能解不了，需要提示） */
    vcodec?: string;
    /** 记住是哪一集，切清晰度时按同一集重播（手动地址没有集） */
    episode?: AnimeEpisode;
    /** 续播起点（秒）：起播时跳过去 */
    startAt?: number;
  } | null>(null);
  /** 观看进度（anime.json）：剧 key → 最近一集 */
  const [progress, setProgress] = useState<
    Record<string, WatchProgress>
  >({});
  /** 收藏（追番）：剧 key → 条目 */
  const [favorites, setFavorites] = useState<
    Record<string, FavoriteEntry>
  >({});
  /** 进度写盘节流：timeupdate 每秒触发，5 秒收口一次 */
  const progressSaveAt = useRef(0);
  /** 选集跳转输入（详情页） */
  const [epJump, setEpJump] = useState("");
  /** 下载任务：进行中百分比 / 单集完成 toast（控制栏）/ 批量完成见下载页 */
  const [dlPct, setDlPct] = useState<
    number | null
  >(null);
  const [dlToast, setDlToast] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  const dlIdRef = useRef(0);
  /** 当前在等的下载任务终态转交（downloadTo 挂上，事件回填） */
  const dlPending = useRef<{
    id: string;
    resolve: (path: string) => void;
    reject: (error: Error) => void;
  } | null>(null);
  /** 批量下载进度：进行中禁止再点批量/单集 */
  const [dlBatch, setDlBatch] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /** 下载任务列表（下载页展示；本会话内的进行中/失败 + 全部完成态） */
  const [dlTasks, setDlTasks] = useState<
    Array<{
      id: string;
      name: string;
      pct: number;
      status: "active" | "done" | "failed";
      path?: string;
      error?: string;
    }>
  >([]);
  /** 已完成的下载记录（anime.json 持久化） */
  const [dlHistory, setDlHistory] = useState<
    DownloadedItem[]
  >([]);
  /** 批量下载勾选模式：剧集中变成可勾选，选完再下 */
  const [dlSelecting, setDlSelecting] =
    useState(false);
  const [dlPicked, setDlPicked] = useState<
    Set<number>
  >(new Set());
  /** Bangumi 匹配到的条目（详情页评分展示 + 同步前提）；null = 没匹配上/还没回来 */
  const [bgmInfo, setBgmInfo] =
    useState<BgmSubjectLite | null>(null);
  /** Bangumi 每日放送日历（「放送表」页；null = 还没加载过） */
  const [bgmCal, setBgmCal] = useState<
    BgmCalendarGroup[] | null
  >(null);
  /** Bangumi 个人令牌：挂载时读一次，同步调用直接用（设置页改了重开弹层生效） */
  const bgmToken = useRef("");
  /** 当前集弹幕（弹弹play 匹配；null=没匹配上/没配凭证/还在加载） */
  const [danmuList, setDanmuList] = useState<
    DanmuComment[] | null
  >(null);
  /** 弹幕开关（anime.json 记住） */
  const [danmuOn, setDanmuOn] = useState(true);

  /** 统一请求壳：busy/error 收口，error 红字落当前视图。 */
  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await work();
      } catch (reason) {
        logError("[anime] 请求失败", reason);
        setError(String(reason));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  /** 聚站首页（网页解析，无需配置域名）：卡片 + 频道导航一次拿全。 */
  const loadJuzHome = useCallback(
    () =>
      run(async () => {
        const { videos, nav, sections } =
          await juzHome();
        setJuzNav(nav);
        setJuzPath("");
        setJuzScreens([]);
        setJuzSections(sections);
        setBrowse({ modules: [], videos });
      }),
    [run]
  );

  /** 聚站列表页（频道分类 / 筛选结果，同一套解析）。 */
  const loadJuzListing = useCallback(
    (path: string) =>
      run(async () => {
        const { videos, screens } =
          await juzListing(path);
        setJuzPath(path);
        setJuzScreens(screens);
        setJuzSections([]);
        setBrowse({ modules: [], videos });
      }),
    [run]
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const config = await loadAnimeConfig();
        if (!alive) return;
        setBaseUrl(config.baseUrl);
        setSavedVolume(config.volume ?? 1);
        setProgress(config.progress ?? {});
        setFavorites(config.favorites ?? {});
        setDlHistory(config.downloads ?? []);
        bgmToken.current = config.bgmToken ?? "";
        setDanmuOn(config.danmuOn !== false);
        // 浏览面只有聚站：开弹层直接进聚站首页
        void loadJuzHome();
      } catch (reason) {
        logError("[anime] 读配置失败", reason);
      }
      try {
        const ready = await invoke<boolean>(
          "anime_transcode_available"
        );
        if (alive) setFfmpegReady(ready);
      } catch (reason) {
        logError(
          "[anime] 探测 ffmpeg 失败",
          reason
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadJuzHome]);

  // 下载进度事件：终态转交给 downloadTo 的 pending promise，中途进度刷新按钮（挂载一次注册）
  useEffect(() => {
    const unlisten = listen<{
      id: string;
      done: number;
      total: number;
      finished: boolean;
      path: string;
      error: string;
    }>("anime-download-progress", event => {
      const payload = event.payload;
      // 任务列表实时百分比（终态由 downloadTo 的 resolve/reject 收口）
      if (!payload.finished) {
        setDlTasks(prev =>
          prev.map(task =>
            task.id === payload.id &&
            payload.total > 0
              ? {
                  ...task,
                  pct: Math.round(
                    (payload.done /
                      payload.total) *
                      100
                  )
                }
              : task
          )
        );
      }
      const pending = dlPending.current;
      if (pending && payload.id === pending.id) {
        if (payload.finished) {
          dlPending.current = null;
          if (payload.error) {
            pending.reject(
              new Error(payload.error)
            );
          } else {
            pending.resolve(payload.path);
          }
          return;
        }
        setDlPct(
          payload.total > 0
            ? Math.round(
                (payload.done / payload.total) *
                  100
              )
            : 0
        );
      }
    });
    return () => {
      void unlisten.then(off => off());
    };
  }, []);

  /** 音量变化持久化（防抖 300ms）：读改写合并，别把进度/收藏抹掉。 */
  const persistVolume = useCallback(
    (volume: number) => {
      if (volumeSaveTimer.current !== null) {
        window.clearTimeout(
          volumeSaveTimer.current
        );
      }
      volumeSaveTimer.current = window.setTimeout(
        () => {
          volumeSaveTimer.current = null;
          // 同步内存值：换视频时播放器重挂，initialVolume 取的就是它——
          // 只写盘不改内存的话，换集后音量会弹回弹层打开时的旧值
          setSavedVolume(volume);
          void (async () => {
            const config =
              await loadAnimeConfig();
            await saveAnimeConfig({
              ...config,
              baseUrl,
              volume
            });
          })().catch(reason =>
            logError(
              "[anime] 保存音量失败",
              reason
            )
          );
        },
        300
      );
    },
    [baseUrl]
  );

  /**
   * 搜索。`keywordArg` 供放送表点条目直接传剧名（不经过输入框）；
   * 传了就回填输入框，让用户看到搜的是什么。
   */
  function search(keywordArg?: string) {
    const keyword = (keywordArg ?? query).trim();
    if (!keyword) return;
    setQuery(keyword);
    void run(async () => {
      // 两边并行搜：参考站结果排前（与线路优先策略一致），失败静默降级为仅聚站
      const [juzVideos, appVideos] =
        await Promise.all([
          juzSearch(keyword),
          baseUrl
            ? animeApi<
                ApiEnvelope & {
                  videos?: AnimeVideo[];
                }
              >(baseUrl, ENDPOINTS.search, {
                keyword,
                pageIndex: 1,
                pageSize: 30
              })
                .then(data =>
                  (data.videos ?? [])
                    // 接口的模糊搜索会带出英文译名命中（「凡人」→ Mortal 这类），
                    // 客户端只留标题/副标题确实含关键词的
                    .filter(
                      video =>
                        video.title.includes(
                          keyword
                        ) ||
                        (
                          video.subTitle ?? ""
                        ).includes(keyword)
                    )
                    .map(video => ({
                      ...video,
                      origin: "app" as const,
                      badgeTag:
                        video.badgeTag ?? "优选"
                    }))
                )
                .catch(reason => {
                  logError(
                    "[anime] 参考站搜索失败",
                    reason
                  );
                  return [];
                })
            : Promise.resolve([])
        ]);
      // 搜索结果替换整个浏览态：不清频道筛选态的话，
      // 渲染会继续落在首页题材分区上，结果永远不显示
      setJuzPath("search");
      setJuzScreens([]);
      setJuzSections([]);
      setBrowse({
        modules: [],
        videos: [...appVideos, ...juzVideos]
      });
    });
  }

  /** 拉每日放送日历（失败存空数组，再点一次「放送表」即重试）。 */
  async function loadBgmCalendar() {
    if (bgmCal) return;
    try {
      setBgmCal(await bgmCalendar());
    } catch (reason) {
      logError(
        "[anime] 放送日历加载失败",
        reason
      );
      setBgmCal([]);
    }
  }

  /** 详情切换后按标题匹配 Bangumi 条目：评分展示 + bgmLinks 缓存（同步复用，免重复搜索）。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!detail) {
        setBgmInfo(null);
        return;
      }
      const key = appLineId ?? detail.id;
      const subject = await bgmFindSubject(
        detail.title
      );
      if (cancelled) return;
      setBgmInfo(subject);
      if (!subject) return;
      try {
        const config = await loadAnimeConfig();
        if (
          (config.bgmLinks?.[key] ?? 0) !==
          subject.id
        ) {
          await saveAnimeConfig({
            ...config,
            bgmLinks: {
              ...(config.bgmLinks ?? {}),
              [key]: subject.id
            }
          });
        }
      } catch (reason) {
        logError(
          "[anime] Bangumi 链接缓存失败",
          reason
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail, appLineId]);

  /** 换集即拉弹幕（弹弹play 匹配 + 拉取在后端/库里，失败静默为 null）。 */
  useEffect(() => {
    const episode = playing?.episode;
    let cancelled = false;
    void (async () => {
      // 先清旧弹幕再拉新的（async 边界内，不算 effect 体同步 setState）
      setDanmuList(null);
      if (!detail || !episode) return;
      const list = await danmuLoad(
        detail.title,
        episode.episodeNum,
        episode.episodeName
      );
      if (!cancelled) setDanmuList(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [playing?.episode, detail]);

  /** 弹幕开关切换（写盘记住，重开弹层生效）。 */
  function toggleDanmu() {
    setDanmuOn(prev => {
      const next = !prev;
      void (async () => {
        const config = await loadAnimeConfig();
        await saveAnimeConfig({
          ...config,
          danmuOn: next
        });
      })().catch(reason =>
        logError(
          "[anime] 保存弹幕开关失败",
          reason
        )
      );
      return next;
    });
  }

  /**
   * 参考站同名线路合并：详情打开后按标题在参考站搜索，标题完全一致才采用
   * （防止同名前缀误合并成另一部剧的剧集），命中就把它的剧集作为「优选线路」
   * 插到线路列表最前；用户还没手动选过线路时自动切过去。
   *
   * 参考站没配域名 / 接口挂了 / 没搜到都静默跳过，不影响聚站主流程。
   */
  async function mergeAppLine(
    title: string,
    juzLines: JuzLine[],
    autoSelect = true
  ) {
    if (!baseUrl) return;
    try {
      const hits = await animeApi<
        ApiEnvelope & { videos?: AnimeVideo[] }
      >(baseUrl, ENDPOINTS.search, {
        keyword: title,
        pageIndex: 1,
        pageSize: 10
      });
      const hit = (hits.videos ?? []).find(
        video =>
          video.title.trim() === title.trim()
      );
      if (!hit) return;
      const ep = await animeApi<
        ApiEnvelope & {
          episodes?: AnimeEpisode[];
        }
      >(baseUrl, ENDPOINTS.episodes, {
        videoId: hit.id,
        code: ""
      });
      const eps = ep.episodes ?? [];
      if (!eps.length) return;
      const merged: JuzLine[] = [
        {
          title: APP_LINE_NAME,
          appVideoId: hit.id,
          episodes: eps
        },
        ...juzLines
      ];
      setJuzLines(merged);
      if (!lineTouched.current && autoSelect) {
        // 用户没选过线路：自动切到参考站线路（优先级最高）
        setJuzLineIdx(0);
        setAppLineId(hit.id);
        setEpPage(0);
        setEpisodes(eps);
      } else {
        // 用户已手动选线：保持其选中内容不变（列表前插一位，下标顺移）
        setJuzLineIdx(index => index + 1);
      }
    } catch (reason) {
      logError(
        "[anime] 参考站线路合并失败",
        reason
      );
    }
  }

  /** 进详情页。带 resume（来自「继续观看」）时自动定位并续播那一集的断点。 */
  function openDetail(
    video: AnimeVideo,
    resume?: { epNum: number; sec: number }
  ) {
    if (video.origin === "app") {
      void run(async () => {
        try {
          const [info, ep] = await Promise.all([
            animeApi<
              ApiEnvelope & {
                video?: AnimeDetail;
              }
            >(baseUrl, ENDPOINTS.detail, {
              videoId: video.id
            }),
            animeApi<
              ApiEnvelope & {
                episodes?: AnimeEpisode[];
              }
            >(baseUrl, ENDPOINTS.episodes, {
              videoId: video.id,
              code: ""
            })
          ]);
          lineTouched.current = false;
          setAppLineId(video.id);
          setDetail(
            info.video ?? {
              ...video,
              description: ""
            }
          );
          setJuzLines([]);
          setJuzLineIdx(0);
          setEpPage(0);
          const eps = ep.episodes ?? [];
          setEpisodes(eps);
          if (resume) {
            const target = eps.find(
              item =>
                item.episodeNum === resume.epNum
            );
            if (target) {
              playApp(
                video.id,
                target,
                resume.sec
              );
            }
          }
        } catch (reason) {
          // 裸「接口返回失败」看不出是哪一步挂了，带上动作
          throw new Error(
            `打开详情失败：${String(reason)}`,
            { cause: reason }
          );
        }
      });
      return;
    }
    void run(async () => {
      const parsed = await juzDetail(video.id);
      lineTouched.current = false;
      setAppLineId(null);
      setDetail(parsed.video);
      setJuzLines(parsed.lines);
      setEpPage(0);
      // 续播：找到含那一集的线路直接开播；找不到（集数变了）就落在第一线路首页
      if (resume) {
        const idx = parsed.lines.findIndex(
          line =>
            line.appVideoId === undefined &&
            line.episodes.some(
              item =>
                item.episodeNum === resume.epNum
            )
        );
        if (idx >= 0) {
          const line = parsed.lines[idx];
          if (!line) return;
          const target = line.episodes.find(
            item =>
              item.episodeNum === resume.epNum
          );
          setJuzLineIdx(idx);
          setEpisodes(line.episodes);
          setEpPage(
            Math.floor(
              (resume.epNum - 1) / EP_PAGE_SIZE
            )
          );
          if (target) {
            await playJuzEpisode(
              parsed.lines,
              idx,
              target,
              resume.sec
            );
          }
          // 续播占住了 run 壳：参考站线路合并放后台，不自动抢选中
          void mergeAppLine(
            parsed.video.title,
            parsed.lines,
            false
          );
          return;
        }
      }
      setJuzLineIdx(0);
      setEpisodes(
        parsed.lines[0]?.episodes ?? []
      );
      await mergeAppLine(
        parsed.video.title,
        parsed.lines,
        !resume
      );
    });
  }

  /**
   * 参考站播放链：加密 API 一条龙（详情线路/搜索条目共用）。
   * 独立成函数是因为续播流程里 appLineId 状态还没来得及提交，只能显式传。
   */
  function playApp(
    videoId: string,
    episode: AnimeEpisode,
    startAt?: number,
    quality?: string
  ) {
    void run(async () => {
      const result = await invoke<{
        playUrl?: string;
        quality?: string;
        qualities?: CinemaQualityOption[];
        vcodec?: string;
      }>("anime_play", {
        baseUrl,
        videoId,
        code: episode.code ?? "",
        episodeNum: episode.episodeNum,
        quality: quality ?? null
      });
      const playUrl = String(
        result.playUrl ?? ""
      );
      if (playUrl) {
        // 用户主动起播（没指定清晰度）时重置回退链
        if (!quality) triedQualities.current = [];
        setPlaying({
          url: playUrl,
          label:
            episode.episodeName ||
            `第 ${episode.episodeNum} 集`,
          quality:
            result.quality ?? quality ?? "",
          qualities: result.qualities ?? [],
          vcodec: result.vcodec ?? "",
          episode,
          startAt
        });
        // H265 直接开软解：WebView2 没有 HEVC 解码器，硬播只有声音。
        // ffmpeg 不可用时保持原样，交给 onNoVideo 兜底提示。
        setSoftDecode(
          ffmpegReady &&
            /265/i.test(result.vcodec ?? "")
        );
        return;
      }
      throw new Error("没有取到播放地址");
    });
  }

  /**
   * 聚站播放链：从 startIdx 的线路开始试，一条失败自动换下一条
   * （dujia* 解析线路经常挂，用户手动换线太折腾）；跳过参考站合并线路。
   * lines 显式传入——续播流程里 state 还没提交，读 state 会拿到旧值。
   */
  async function playJuzEpisode(
    lines: JuzLine[],
    startIdx: number,
    episode: AnimeEpisode,
    startAt?: number
  ) {
    const order: number[] = [];
    for (
      let i = startIdx;
      i < lines.length;
      i += 1
    )
      order.push(i);
    for (let i = 0; i < startIdx; i += 1)
      order.push(i);
    let lastError: unknown = null;
    for (const idx of order) {
      const line = lines[idx];
      if (!line || line.appVideoId) continue;
      const target = line.episodes.find(
        item =>
          item.episodeNum === episode.episodeNum
      );
      const playPath = target?.code ?? "";
      if (
        !/^\/vodplay\/\d+-\d+-\d+\/$/.test(
          playPath
        )
      ) {
        continue;
      }
      try {
        const { playUrl: raw } =
          await juzPlay(playPath);
        const playUrl = isDirectPlayUrl(raw)
          ? raw
          : await juzResolveToken(raw);
        // 命中哪条线就把界面切到哪条（用户看到的就是在播的）
        if (idx !== juzLineIdx) {
          setJuzLineIdx(idx);
          setEpisodes(line.episodes);
        }
        setAppLineId(null);
        setEpPage(
          Math.floor(
            (episode.episodeNum - 1) /
              EP_PAGE_SIZE
          )
        );
        setPlaying({
          url: playUrl,
          label:
            target?.episodeName ||
            `第 ${episode.episodeNum} 集`,
          quality: "",
          qualities: [],
          vcodec: "",
          episode: target ?? episode,
          startAt
        });
        setSoftDecode(false);
        return;
      } catch (reason) {
        lastError = reason;
        logError(
          "[anime] 线路播放失败，自动换下一条",
          reason
        );
      }
    }
    throw (
      lastError ??
      new Error("这一集没有可用的播放地址")
    );
  }

  /**
   * 播一集：按当前选中线路的来源分流。
   *
   * `quality` 为空时由后端取接口给的默认清晰度；切换清晰度会带着目标值
   * 重跑整条链——每一步都签了 exchangeToken，不能只换最后一段地址。
   */
  function play(
    episode: AnimeEpisode,
    quality?: string
  ) {
    if (!detail) return;
    if (appLineId) {
      playApp(
        appLineId,
        episode,
        undefined,
        quality
      );
      return;
    }
    void run(() =>
      playJuzEpisode(
        juzLines,
        juzLineIdx,
        episode
      )
    );
  }

  /** 播放进度上报（播放器 timeupdate 驱动，5 秒收口写盘一次；开头 15 秒内的不算观看）。 */
  function handleProgress(
    sec: number,
    duration?: number
  ) {
    if (!detail || !playing?.episode) return;
    if (sec < 15) return;
    const now = Date.now();
    if (now - progressSaveAt.current < 5000)
      return;
    progressSaveAt.current = now;
    // ⚠️ key 必须跟 origin 配套：参考站线路播放时用 app 的 videoId，
    // 用聚站 voddetail 路径当 key 标 origin=app，续播时就会拿错 ID 查接口
    const key = appLineId ?? detail.id;
    const entry: WatchProgress = {
      title: detail.title,
      poster: coverOf(detail) || undefined,
      origin: appLineId ? "app" : undefined,
      epNum: playing.episode.episodeNum,
      sec,
      duration,
      updatedAt: now
    };
    setProgress(prev => ({
      ...prev,
      [key]: entry
    }));
    void saveWatchProgress(key, entry).catch(
      reason =>
        logError("[anime] 保存进度失败", reason)
    );
    // Bangumi 同步：看完一集（≥90%；时长未知看满 15 分钟）打点「已看」+ 确保「在看」收藏。
    // 令牌没配就一步都不发；失败静默（bangumi.ts 里吞）。
    const ratio =
      duration && duration > 0
        ? sec / duration
        : 0;
    if (
      bgmToken.current &&
      (ratio >= 0.9 || (!duration && sec >= 900))
    ) {
      void bgmSyncProgress({
        token: bgmToken.current,
        key,
        title: detail.title,
        epNum: playing.episode.episodeNum,
        sec,
        duration
      });
    }
  }

  /** 收藏/取消收藏当前详情（按钮态跟着 favorites 内存值走）。key 与 origin 配套，同 handleProgress。 */
  async function toggleFav() {
    if (!detail) return;
    const key = appLineId ?? detail.id;
    const entry = {
      title: detail.title,
      poster: coverOf(detail) || undefined,
      origin: appLineId
        ? ("app" as const)
        : undefined
    };
    const added = await toggleFavorite(
      key,
      entry
    ).catch(reason => {
      logError("[anime] 收藏失败", reason);
      return null;
    });
    if (added === null) return;
    setFavorites(prev => {
      const next = { ...prev };
      if (added) {
        next[key] = {
          ...entry,
          addedAt: Date.now()
        };
      } else {
        delete next[key];
      }
      return next;
    });
    // 收藏 → Bangumi「在看」：同样静默，失败不打扰
    if (added && bgmToken.current) {
      void bgmCollect(
        bgmToken.current,
        detail.title
      );
    }
  }

  /** 弹目录选择框；取消返回 null（调用方静默收手）。 */
  async function pickOutDir(): Promise<
    string | null
  > {
    try {
      return await invoke<string | null>(
        "anime_pick_download_dir"
      );
    } catch (reason) {
      setError(String(reason));
      return null;
    }
  }

  /** 下载一集到指定目录，等终态事件回来（resolve 成品路径）。 */
  function downloadTo(
    url: string,
    name: string,
    dir: string
  ): Promise<string> {
    const id = `dl-${(dlIdRef.current += 1)}`;
    // executor 外留 settle 引用：invoke 先失败也要能 reject
    let settle!: {
      resolve: (path: string) => void;
      reject: (error: Error) => void;
    };
    const done = new Promise<string>(
      (resolve, reject) => {
        settle = { resolve, reject };
      }
    );
    // 挂任务卡片；终态在此收口（完成顺带写持久化记录，同 path 去重置顶）
    setDlTasks(prev => [
      {
        id,
        name,
        pct: 0,
        status: "active" as const
      },
      ...prev
    ]);
    dlPending.current = {
      id,
      resolve: path => {
        setDlTasks(prev =>
          prev.map(task =>
            task.id === id
              ? {
                  ...task,
                  pct: 100,
                  status: "done" as const,
                  path
                }
              : task
          )
        );
        setDlHistory(prev => {
          const next = [
            {
              path,
              name,
              savedAt: Date.now()
            },
            ...prev.filter(
              item => item.path !== path
            )
          ];
          void saveDownloads(next).catch(reason =>
            logError(
              "[anime] 保存下载记录失败",
              reason
            )
          );
          return next;
        });
        settle.resolve(path);
      },
      reject: error => {
        setDlTasks(prev =>
          prev.map(task =>
            task.id === id
              ? {
                  ...task,
                  status: "failed" as const,
                  error: error.message
                }
              : task
          )
        );
        settle.reject(error);
      }
    };
    void invoke("anime_download", {
      id,
      url,
      name,
      outDir: dir
    }).catch(reason => {
      dlPending.current = null;
      settle.reject(new Error(String(reason)));
    });
    return done;
  }

  /** 解析一集的可播地址（参考站走 anime_play 链，聚站走解析线路），批量下载逐集用。 */
  async function resolveEpisodeUrl(
    ep: AnimeEpisode
  ): Promise<string> {
    if (appLineId) {
      const result = await invoke<{
        playUrl?: string;
      }>("anime_play", {
        baseUrl,
        videoId: appLineId,
        code: ep.code ?? "",
        episodeNum: ep.episodeNum,
        quality: null
      });
      const url = String(result.playUrl ?? "");
      if (!url)
        throw new Error("没有取到播放地址");
      return url;
    }
    const playPath = ep.code ?? "";
    if (
      !/^\/vodplay\/\d+-\d+-\d+\/$/.test(playPath)
    ) {
      throw new Error(
        `第 ${ep.episodeNum} 集没有播放地址`
      );
    }
    const { playUrl: raw } =
      await juzPlay(playPath);
    return isDirectPlayUrl(raw)
      ? raw
      : await juzResolveToken(raw);
  }

  /** 删除一条下载记录：连带删掉磁盘上的文件（用户自己下的，删前不再二次确认）。 */
  async function removeDownload(
    item: DownloadedItem
  ) {
    try {
      await invoke("fs_remove_path", {
        path: item.path
      });
    } catch (reason) {
      // 文件已经不在了（手动删过）也照样移记录；真删失败才报
      if (
        !String(reason).includes("找不到") &&
        !String(reason).includes("系统找不到")
      ) {
        setError(
          `删除 ${item.path} 失败：${String(reason)}`
        );
        return;
      }
    }
    setDlHistory(prev => {
      const next = prev.filter(
        entry => entry.path !== item.path
      );
      void saveDownloads(next).catch(reason =>
        logError(
          "[anime] 更新下载记录失败",
          reason
        )
      );
      return next;
    });
    setDlTasks(prev =>
      prev.filter(task => task.path !== item.path)
    );
  }

  /** 下载当前集：先选目录（取消静默收手），再单集下载；完成走控制栏 toast。 */ async function startDownload() {
    if (!playing || !detail) return;
    const dir = await pickOutDir();
    if (!dir) return;
    setDlPct(0);
    try {
      const path = await downloadTo(
        playing.url,
        `${detail.title}-${playing.label}`,
        dir
      );
      setDlPct(null);
      setDlToast({
        text: `已保存到 ${path}`,
        nonce: Date.now()
      });
    } catch (reason) {
      setDlPct(null);
      setDlToast({
        text: String(reason),
        nonce: Date.now()
      });
    }
  }

  /**
   * 批量下载当前线路的全部集数：选一次目录，逐集解析→串行排队下载
   * （不并发抢带宽）。单集失败跳过继续，结束后汇报失败集号。
   */
  async function startBatchDownload(
    list: AnimeEpisode[]
  ) {
    if (!detail || !list.length) return;
    const dir = await pickOutDir();
    if (!dir) return;
    // 退出勾选模式
    setDlSelecting(false);
    setDlPicked(new Set());
    const failed: number[] = [];
    setDlPct(null);
    setDlBatch({ done: 0, total: list.length });
    for (const ep of list) {
      try {
        const url = await resolveEpisodeUrl(ep);
        await downloadTo(
          url,
          `${detail.title}-${ep.episodeName || `第${ep.episodeNum}集`}`,
          dir
        );
      } catch (reason) {
        logError(
          "[anime] 批量下载单集失败",
          reason
        );
        failed.push(ep.episodeNum);
      }
      setDlBatch(prev =>
        prev
          ? { ...prev, done: prev.done + 1 }
          : prev
      );
    }
    setDlBatch(null);
    if (failed.length) {
      setError(
        `批量下载完成 ${list.length - failed.length}/${list.length}，失败集号：${failed.join("、")}`
      );
    }
    // 全部成功不弹提示：下载页里已经能看到记录
  }

  /**
   * 有声音没画面：视频轨解码失败。
   *
   * 常见于 H.265（WebView2 默认不带 HEVC 解码器），也可能源把编码标错。
   * 这里不猜编码，直接按清晰度逐档回退；全试完还不行就把原因说清楚。
   */
  function handleNoVideo() {
    if (!playing) return;
    // 先试软解：同一条地址交给 ffmpeg 转 H264，比换档更可能成功
    if (ffmpegReady && !softDecode) {
      console.info("[anime] 开软解重试");
      setSoftDecode(true);
      return;
    }
    const current = playing.quality;
    if (
      current &&
      !triedQualities.current.includes(current)
    ) {
      triedQualities.current.push(current);
    }
    const next = playing.qualities.find(
      option =>
        // 会员档点了也是白挨一次拒绝，直接跳过
        !option.isVipOnly &&
        !triedQualities.current.includes(
          option.quality
        )
    );
    if (next && playing.episode) {
      console.warn(
        "[anime] 视频轨解不出，换清晰度重试：",
        next.quality
      );
      play(playing.episode, next.quality);
      return;
    }
    // 走到这里说明非会员档已经全试过：编码是 H265（或后端没报编码，多为旧构建），
    // 基本就是系统缺 HEVC 解码器，直接把话说明白，别让用户反复切档
    const looksHevc =
      !playing.vcodec ||
      playing.vcodec
        .toUpperCase()
        .includes("265");
    setError(
      looksHevc
        ? "这一集的线路都是 H.265(HEVC)，系统没装 HEVC 解码器时只有声音——装「HEVC 视频扩展」后重开 App，或换一集/换一部"
        : "视频轨解不出来，换一档清晰度或换源试试"
    );
  }

  function backToBrowse() {
    setDetail(null);
    setEpisodes([]);
    setPlaying(null);
  }

  /** 播放器顶部「返回」：退回详情页（不关弹层）。 */
  function backToDetail() {
    setPlaying(null);
  }

  /** 下一集（选集菜单与「下一集」按钮共用）。 */
  function playNextEpisode() {
    if (!playing?.episode) return;
    const idx = episodes.findIndex(
      ep =>
        ep.episodeNum ===
        playing.episode?.episodeNum
    );
    const next =
      idx >= 0 ? episodes[idx + 1] : undefined;
    if (next) play(next);
  }

  const cards =
    browse?.videos.length ||
    browse?.modules.some(
      module => module.videos?.length
    )
      ? browse?.videos.length
        ? browse.videos
        : (browse?.modules.flatMap(
            module => module.videos ?? []
          ) ?? [])
      : [];

  /** 继续观看：按最近观看时间倒序，最多 12 部 */
  const resumeList = Object.entries(progress)
    .sort(
      (a, b) => b[1].updatedAt - a[1].updatedAt
    )
    .slice(0, 12);
  /** 收藏：按收藏时间倒序，最多 12 部 */
  const favList = Object.entries(favorites)
    .sort((a, b) => b[1].addedAt - a[1].addedAt)
    .slice(0, 12);

  // 播放器标题：「动漫名 · 集名」。episodeName 有就用它（含集号）。
  const playingTitle = playing
    ? [
        detail?.title,
        playing.episode
          ? playing.episode.episodeName ||
            `第 ${playing.episode.episodeNum} 集`
          : playing.label
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // 当前集在列表里的下一集是否存在（有才渲染「下一集」按钮）
  const hasNextEpisode = playing
    ? episodes.findIndex(
        ep =>
          ep.episodeNum ===
          playing.episode?.episodeNum
      ) <
      episodes.length - 1
    : false;

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      {/* 播放弹层只认右上角 X：误触弹层外的黑边就整层消失，看片体验太差 */}
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container placement="center">
          <Modal.Dialog
            className={
              "anime-dialog" +
              (playing
                ? " anime-dialog--playing"
                : "")
            }
          >
            <Modal.Header>
              {/* 播放态不渲染弹层头：返回+标题已在播放器自身的影院顶栏里，重复两行 */}
              {!playing && (
                <div className="anime-header-row">
                  {detail && (
                    <button
                      type="button"
                      className="anime-header-back"
                      onClick={backToBrowse}
                    >
                      <ArrowLeftOutlined />
                      {t("anime.back")}
                    </button>
                  )}
                  <Modal.Heading className="anime-header-title">
                    {detail
                      ? detail.title
                      : t("anime.title")}
                  </Modal.Heading>
                </div>
              )}
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body className="dialog-scroll anime-body">
              {!detail && (
                <>
                  <div className="anime-search-row">
                    <input
                      className="settings-input"
                      placeholder={t(
                        "anime.search"
                      )}
                      value={query}
                      onChange={event =>
                        setQuery(
                          event.target.value
                        )
                      }
                      onKeyDown={event => {
                        if (event.key === "Enter")
                          search();
                      }}
                    />
                    <Button
                      variant="tertiary"
                      size="sm"
                      isDisabled={busy}
                      onPress={() => search()}
                    >
                      {t("anime.searchAction")}
                    </Button>
                  </div>
                </>
              )}
              {error && (
                <p className="dialog-error">
                  {error}
                </p>
              )}
              {playing ? (
                <div className="anime-player-wrap">
                  {softDecode ? (
                    <TranscodePlayer
                      // key 绑 src：换集/换清晰度必须重挂，否则会带着
                      // 上一集的拖拽位置（内部 startAt）开始转码
                      key={playing.url}
                      src={playing.url}
                      title={playingTitle}
                      onError={message =>
                        setError(message)
                      }
                      qualities={
                        playing.qualities
                      }
                      activeQuality={
                        playing.quality
                      }
                      onSelectQuality={quality => {
                        if (!playing.episode)
                          return;
                        play(
                          playing.episode,
                          quality
                        );
                      }}
                      episodes={episodes}
                      activeEpisodeNum={
                        playing.episode
                          ?.episodeNum
                      }
                      onPlayEpisode={ep =>
                        play(ep)
                      }
                      onBack={backToDetail}
                      onNextEpisode={
                        hasNextEpisode
                          ? playNextEpisode
                          : undefined
                      }
                      initialVolume={savedVolume}
                      switching={busy}
                      onVolumePersist={
                        persistVolume
                      }
                      startAt={playing.startAt}
                      onProgress={handleProgress}
                      onDownload={startDownload}
                      downloadPct={dlPct}
                      downloadHint={dlToast}
                      danmuComments={
                        danmuOn ? danmuList : null
                      }
                      danmuOn={danmuOn}
                      onToggleDanmu={toggleDanmu}
                    />
                  ) : (
                    <VideoPlayer
                      key={playing.url}
                      src={playing.url}
                      title={playingTitle}
                      onError={message =>
                        setError(message)
                      }
                      onNoVideo={handleNoVideo}
                      qualities={
                        playing.qualities
                      }
                      activeQuality={
                        playing.quality
                      }
                      onSelectQuality={quality => {
                        if (!playing.episode)
                          return;
                        play(
                          playing.episode,
                          quality
                        );
                      }}
                      episodes={episodes}
                      activeEpisodeNum={
                        playing.episode
                          ?.episodeNum
                      }
                      onPlayEpisode={ep =>
                        play(ep)
                      }
                      onBack={backToDetail}
                      onNextEpisode={
                        hasNextEpisode
                          ? playNextEpisode
                          : undefined
                      }
                      initialVolume={savedVolume}
                      switching={busy}
                      onVolumePersist={
                        persistVolume
                      }
                      startAt={playing.startAt}
                      onProgress={handleProgress}
                      onDownload={startDownload}
                      downloadPct={dlPct}
                      downloadHint={dlToast}
                      danmuComments={
                        danmuOn ? danmuList : null
                      }
                      danmuOn={danmuOn}
                      onToggleDanmu={toggleDanmu}
                    />
                  )}
                </div>
              ) : detail ? (
                <div className="anime-detail">
                  <div className="anime-detail-head">
                    {coverOf(detail) ? (
                      <img
                        className="anime-detail-poster"
                        src={coverOf(detail)}
                        alt={detail.title}
                        loading="lazy"
                      />
                    ) : null}
                    <div className="anime-detail-meta">
                      <p className="anime-line">
                        {[
                          detail.categoryName,
                          detail.year,
                          detail.area,
                          detail.language,
                          detail.isFinished
                            ? t("anime.finished")
                            : detail.updateSchedule
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {detail.score ? (
                        <p className="anime-line">
                          ⭐ {detail.score}
                        </p>
                      ) : null}
                      {/* Bangumi 匹配到的评分：点开条目页看完整信息 */}
                      {bgmInfo &&
                      bgmInfo.score !== null ? (
                        <button
                          type="button"
                          className="anime-line anime-bgm-score"
                          title="在 bgm.tv 打开条目"
                          onClick={() =>
                            void openUrl(
                              `https://bgm.tv/subject/${bgmInfo.id}`
                            )
                          }
                        >
                          {`Bangumi ⭐ ${bgmInfo.score.toFixed(1)}`}
                        </button>
                      ) : null}
                      {detail.actors ? (
                        <p className="anime-line anime-clamp">
                          {detail.actors}
                        </p>
                      ) : null}
                      {detail.description ? (
                        <p className="anime-line anime-clamp">
                          {detail.description}
                        </p>
                      ) : bgmInfo?.summary ? (
                        <p className="anime-line anime-clamp">
                          {bgmInfo.summary}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className={
                          "anime-fav-btn" +
                          (favorites[
                            appLineId ?? detail.id
                          ]
                            ? " is-fav"
                            : "")
                        }
                        onClick={() =>
                          void toggleFav()
                        }
                      >
                        {favorites[
                          appLineId ?? detail.id
                        ] ? (
                          <HeartFilled />
                        ) : (
                          <HeartOutlined />
                        )}
                        {favorites[
                          appLineId ?? detail.id
                        ]
                          ? " 已收藏"
                          : " 收藏"}
                      </button>
                    </div>
                  </div>
                  {juzLines.length > 1 && (
                    <div className="anime-line-row">
                      <span className="anime-line-label">
                        线路
                      </span>
                      {juzLines.map(
                        (line, index) => (
                          <button
                            key={
                              line.title + index
                            }
                            type="button"
                            className={
                              "anime-line-chip" +
                              (index ===
                              juzLineIdx
                                ? " is-active"
                                : "")
                            }
                            disabled={busy}
                            // 悬停显示线路原名（参考站线路是自定义名，聚站是营销名）
                            title={line.title}
                            onClick={() => {
                              lineTouched.current = true;
                              setJuzLineIdx(
                                index
                              );
                              setAppLineId(
                                line.appVideoId ??
                                  null
                              );
                              setEpPage(0);
                              setEpisodes(
                                line.episodes
                              );
                            }}
                          >
                            {`${
                              line.appVideoId
                                ? APP_LINE_NAME
                                : `线路 ${index + 1}`
                            } · ${line.episodes.length}集`}
                          </button>
                        )
                      )}
                    </div>
                  )}
                  <div className="anime-ep-head">
                    <p className="anime-section-label">
                      {t("anime.episodes")}
                    </p>
                    {episodes.length &&
                    dlBatch !== null ? (
                      <button
                        type="button"
                        className="anime-line-chip"
                        onClick={() =>
                          void startBatchDownload(
                            episodes
                          )
                        }
                      >
                        <DownloadOutlined />
                        {` 下载中 ${dlBatch.done}/${dlBatch.total}`}
                      </button>
                    ) : episodes.length &&
                      dlSelecting ? (
                      <div className="anime-ep-actions">
                        <button
                          type="button"
                          className="anime-line-chip"
                          onClick={() => {
                            setDlSelecting(false);
                            setDlPicked(
                              new Set()
                            );
                          }}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="anime-line-chip"
                          onClick={() =>
                            setDlPicked(
                              new Set(
                                episodes.map(
                                  ep =>
                                    ep.episodeNum
                                )
                              )
                            )
                          }
                        >
                          全选本线路
                        </button>
                        <button
                          type="button"
                          className="anime-line-chip is-active"
                          disabled={
                            dlPicked.size === 0
                          }
                          onClick={() =>
                            void startBatchDownload(
                              episodes.filter(
                                ep =>
                                  dlPicked.has(
                                    ep.episodeNum
                                  )
                              )
                            )
                          }
                        >
                          {`开始下载（${dlPicked.size}）`}
                        </button>
                      </div>
                    ) : episodes.length ? (
                      <button
                        type="button"
                        className="anime-line-chip"
                        onClick={() =>
                          setDlSelecting(true)
                        }
                      >
                        <DownloadOutlined />
                        {" 批量下载"}
                      </button>
                    ) : null}
                  </div>
                  {episodes.length ? (
                    <>
                      {episodes.length >
                        EP_PAGE_SIZE && (
                        <div className="cin-ep-tabs-row">
                          <div
                            ref={epTabsRef}
                            className="cin-ep-tabs"
                          >
                            {Array.from(
                              {
                                length: Math.ceil(
                                  episodes.length /
                                    EP_PAGE_SIZE
                                )
                              },
                              (_, i) => (
                                <button
                                  key={i}
                                  type="button"
                                  className={
                                    "cin-ep-tab" +
                                    (i === epPage
                                      ? " is-active"
                                      : "")
                                  }
                                  onClick={e => {
                                    setEpPage(i);
                                    // 点到视口外的页签时把它滚进可视区（不改选中页）
                                    e.currentTarget.scrollIntoView(
                                      {
                                        block:
                                          "nearest",
                                        inline:
                                          "nearest",
                                        behavior:
                                          "smooth"
                                      }
                                    );
                                  }}
                                >
                                  {i *
                                    EP_PAGE_SIZE +
                                    1}
                                  -
                                  {Math.min(
                                    (i + 1) *
                                      EP_PAGE_SIZE,
                                    episodes.length
                                  )}
                                </button>
                              )
                            )}
                          </div>
                          {/* 箭头只平移页签条本身一屏，不改选中页（scrollBy 越界自动夹紧） */}
                          <button
                            type="button"
                            className="cin-ep-arrow"
                            aria-label="页签左移"
                            onClick={() =>
                              epTabsRef.current?.scrollBy(
                                {
                                  left: -epTabsRef
                                    .current
                                    .clientWidth,
                                  behavior:
                                    "smooth"
                                }
                              )
                            }
                          >
                            <LeftOutlined />
                          </button>
                          <button
                            type="button"
                            className="cin-ep-arrow"
                            aria-label="页签右移"
                            onClick={() =>
                              epTabsRef.current?.scrollBy(
                                {
                                  left: epTabsRef
                                    .current
                                    .clientWidth,
                                  behavior:
                                    "smooth"
                                }
                              )
                            }
                          >
                            <RightOutlined />
                          </button>
                          {/* 集号直达：输入 198 回车 → 跳到含第 198 集的页 */}
                          <input
                            className="anime-ep-jump"
                            placeholder="集号"
                            value={epJump}
                            onChange={event =>
                              setEpJump(
                                event.target.value.replace(
                                  /\D/g,
                                  ""
                                )
                              )
                            }
                            onKeyDown={event => {
                              if (
                                event.key !==
                                "Enter"
                              )
                                return;
                              const target =
                                Number(epJump);
                              if (
                                target >= 1 &&
                                target <=
                                  episodes.length
                              ) {
                                setEpPage(
                                  Math.floor(
                                    (target - 1) /
                                      EP_PAGE_SIZE
                                  )
                                );
                                setEpJump("");
                              }
                            }}
                          />
                        </div>
                      )}
                      <div className="anime-episode-grid">
                        {episodes
                          .slice(
                            epPage * EP_PAGE_SIZE,
                            (epPage + 1) *
                              EP_PAGE_SIZE
                          )
                          .map(episode => (
                            <button
                              key={
                                episode.episodeNum
                              }
                              className={
                                "anime-episode-chip" +
                                (dlSelecting &&
                                dlPicked.has(
                                  episode.episodeNum
                                )
                                  ? " is-picked"
                                  : "")
                              }
                              disabled={busy}
                              onClick={() => {
                                // 勾选模式下点 chip = 选中/取消该集，不播
                                if (dlSelecting) {
                                  setDlPicked(
                                    prev => {
                                      const next =
                                        new Set(
                                          prev
                                        );
                                      if (
                                        next.has(
                                          episode.episodeNum
                                        )
                                      ) {
                                        next.delete(
                                          episode.episodeNum
                                        );
                                      } else {
                                        next.add(
                                          episode.episodeNum
                                        );
                                      }
                                      return next;
                                    }
                                  );
                                  return;
                                }
                                play(episode);
                              }}
                            >
                              {episode.episodeName ||
                                episode.episodeNum}
                            </button>
                          ))}
                      </div>
                    </>
                  ) : (
                    <p className="anime-hint">
                      {busy
                        ? t("anime.loading")
                        : t("anime.empty")}
                    </p>
                  )}
                </div>
              ) : // 聚站浏览页：左侧频道栏 + 筛选 chips + 大卡网格（腾讯视频排版）
              juzNav.length ? (
                <div className="anime-juz">
                  <div className="anime-juz-nav">
                    <button
                      type="button"
                      className={
                        "anime-juz-nav-item" +
                        (juzPath === ""
                          ? " is-active"
                          : "")
                      }
                      disabled={busy}
                      onClick={() =>
                        void loadJuzHome()
                      }
                    >
                      首页
                    </button>
                    {/* 放送表：Bangumi 每日放送（本地页，不走站点） */}
                    <button
                      type="button"
                      className={
                        "anime-juz-nav-item" +
                        (juzPath === "calendar"
                          ? " is-active"
                          : "")
                      }
                      onClick={() => {
                        setJuzPath("calendar");
                        void loadBgmCalendar();
                      }}
                    >
                      放送表
                    </button>
                    {juzNav.map(item => (
                      <button
                        key={item.path}
                        type="button"
                        className={
                          "anime-juz-nav-item" +
                          (juzPath === item.path
                            ? " is-active"
                            : "")
                        }
                        disabled={busy}
                        onClick={() =>
                          void loadJuzListing(
                            item.path
                          )
                        }
                      >
                        {item.title}
                      </button>
                    ))}
                    {/* 我的两个本地页：数据全在 anime.json，不走站点 */}
                    <button
                      type="button"
                      className={
                        "anime-juz-nav-item" +
                        (juzPath === "resume"
                          ? " is-active"
                          : "")
                      }
                      onClick={() =>
                        setJuzPath("resume")
                      }
                    >
                      继续观看
                    </button>
                    <button
                      type="button"
                      className={
                        "anime-juz-nav-item" +
                        (juzPath === "fav"
                          ? " is-active"
                          : "")
                      }
                      onClick={() =>
                        setJuzPath("fav")
                      }
                    >
                      收藏
                    </button>
                    <button
                      type="button"
                      className={
                        "anime-juz-nav-item" +
                        (juzPath === "downloads"
                          ? " is-active"
                          : "")
                      }
                      onClick={() =>
                        setJuzPath("downloads")
                      }
                    >
                      {`下载${
                        dlTasks.some(
                          task =>
                            task.status ===
                            "active"
                        )
                          ? " •"
                          : ""
                      }`}
                    </button>
                  </div>
                  <div className="anime-juz-main">
                    {/* 切频道/筛选加载中：半透明罩盖住旧内容 + 转圈 */}
                    {busy && (
                      <div className="anime-juz-loading">
                        <div className="cin-spin" />
                      </div>
                    )}
                    {/* 本地页不显示站点筛选行 */}
                    {juzPath !== "resume" &&
                      juzPath !== "fav" &&
                      juzPath !== "downloads" &&
                      juzPath !== "calendar" &&
                      juzScreens.map(group => (
                        <ScreenStrip
                          key={group.label}
                          label={group.label}
                          options={group.options}
                          activePath={juzPath}
                          busy={busy}
                          onPick={opt =>
                            void loadJuzListing(
                              opt.path
                            )
                          }
                        />
                      ))}
                    {/* 继续观看 / 收藏：频道栏里的两个本地页，小缩略图横排列表 */}
                    {juzPath === "resume" &&
                      (resumeList.length ? (
                        <div className="anime-history-list">
                          {resumeList.map(
                            ([key, entry]) => (
                              <button
                                key={key}
                                type="button"
                                className="anime-history-item"
                                onClick={() =>
                                  openDetail(
                                    {
                                      id: key,
                                      title:
                                        entry.title,
                                      posterUrl:
                                        entry.poster,
                                      origin:
                                        entry.origin
                                    },
                                    {
                                      epNum:
                                        entry.epNum,
                                      sec: entry.sec
                                    }
                                  )
                                }
                              >
                                {entry.poster ? (
                                  <img
                                    className="anime-history-thumb"
                                    src={
                                      entry.poster
                                    }
                                    alt={
                                      entry.title
                                    }
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="anime-history-thumb anime-history-fallback">
                                    {entry.title.slice(
                                      0,
                                      1
                                    )}
                                  </span>
                                )}
                                <span className="anime-history-info">
                                  <span className="anime-history-title">
                                    {entry.title}
                                  </span>
                                  <span className="anime-history-meta">
                                    {`第${entry.epNum}集${
                                      entry.duration
                                        ? ` · 看到 ${Math.round((entry.sec / entry.duration) * 100)}%`
                                        : ""
                                    } · ${timeAgo(entry.updatedAt)}`}
                                  </span>
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      ) : (
                        <p className="anime-hint">
                          {t("anime.empty")}
                        </p>
                      ))}
                    {juzPath === "fav" &&
                      (favList.length ? (
                        <div className="anime-history-list">
                          {favList.map(
                            ([key, entry]) => (
                              <button
                                key={key}
                                type="button"
                                className="anime-history-item"
                                onClick={() =>
                                  openDetail({
                                    id: key,
                                    title:
                                      entry.title,
                                    posterUrl:
                                      entry.poster,
                                    origin:
                                      entry.origin
                                  })
                                }
                              >
                                {entry.poster ? (
                                  <img
                                    className="anime-history-thumb"
                                    src={
                                      entry.poster
                                    }
                                    alt={
                                      entry.title
                                    }
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="anime-history-thumb anime-history-fallback">
                                    {entry.title.slice(
                                      0,
                                      1
                                    )}
                                  </span>
                                )}
                                <span className="anime-history-info">
                                  <span className="anime-history-title">
                                    {entry.title}
                                  </span>
                                  <span className="anime-history-meta">
                                    {timeAgo(
                                      entry.addedAt
                                    )}
                                  </span>
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      ) : (
                        <p className="anime-hint">
                          {t("anime.empty")}
                        </p>
                      ))}
                    {/* 放送表：Bangumi 每日放送，点条目进两源搜索 */}
                    {juzPath === "calendar" &&
                      (bgmCal === null ? (
                        <p className="anime-hint">
                          {t("anime.loading")}
                        </p>
                      ) : bgmCal.length ? (
                        <div className="anime-bgm-cal">
                          {bgmCal.map(
                            (group, idx) => (
                              <div
                                className="anime-bgm-cal-group"
                                key={
                                  group.weekdayCn ||
                                  idx
                                }
                              >
                                <p
                                  className={
                                    "anime-bgm-cal-day" +
                                    (group.isToday
                                      ? " is-today"
                                      : "")
                                  }
                                >
                                  {
                                    group.weekdayCn
                                  }
                                  {group.isToday
                                    ? " · 今天"
                                    : ""}
                                </p>
                                <div className="anime-bgm-cal-grid">
                                  {group.items.map(
                                    item => (
                                      <button
                                        key={
                                          item.id
                                        }
                                        type="button"
                                        className="anime-bgm-cal-item"
                                        title={
                                          item.nameCn ||
                                          item.name
                                        }
                                        onClick={() =>
                                          search(
                                            item.nameCn ||
                                              item.name
                                          )
                                        }
                                      >
                                        {item.image ? (
                                          <img
                                            src={
                                              item.image
                                            }
                                            alt=""
                                            loading="lazy"
                                          />
                                        ) : (
                                          <span className="anime-bgm-cal-thumb">
                                            {(
                                              item.nameCn ||
                                              item.name
                                            ).slice(
                                              0,
                                              1
                                            )}
                                          </span>
                                        )}
                                        <span className="anime-bgm-cal-title">
                                          {item.nameCn ||
                                            item.name}
                                        </span>
                                      </button>
                                    )
                                  )}
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      ) : (
                        <p className="anime-hint">
                          {t("anime.empty")}
                        </p>
                      ))}
                    {/* 下载页：进行中任务 + 已保存列表（持久化） */}
                    {juzPath === "downloads" &&
                    dlTasks.filter(
                      task =>
                        task.status === "active"
                    ).length +
                      dlTasks.filter(
                        task =>
                          task.status === "failed"
                      ).length +
                      dlHistory.length ===
                      0 ? (
                      <p className="anime-hint">
                        {t("anime.empty")}
                      </p>
                    ) : juzPath ===
                      "downloads" ? (
                      <div className="anime-history-list">
                        {dlTasks
                          .filter(
                            task =>
                              task.status ===
                              "active"
                          )
                          .map(task => (
                            <div
                              key={task.id}
                              className="anime-history-item is-static"
                            >
                              <span className="anime-history-thumb anime-history-fallback">
                                <DownloadOutlined />
                              </span>
                              <span className="anime-history-info">
                                <span className="anime-history-title">
                                  {task.name}
                                </span>
                                <span className="anime-history-meta">
                                  {`下载中 ${task.pct}%`}
                                </span>
                              </span>
                            </div>
                          ))}
                        {dlTasks
                          .filter(
                            task =>
                              task.status ===
                              "failed"
                          )
                          .map(task => (
                            <div
                              key={task.id}
                              className="anime-history-item is-static"
                            >
                              <span className="anime-history-thumb anime-history-fallback">
                                <DownloadOutlined />
                              </span>
                              <span className="anime-history-info">
                                <span className="anime-history-title">
                                  {task.name}
                                </span>
                                <span className="anime-history-meta">
                                  {`失败：${task.error ?? "未知原因"}`}
                                </span>
                              </span>
                            </div>
                          ))}
                        {dlHistory.map(item => (
                          <div
                            key={item.path}
                            className="anime-history-item is-static"
                            title={item.path}
                          >
                            <span className="anime-history-thumb anime-history-fallback">
                              <DownloadOutlined />
                            </span>
                            <span className="anime-history-info">
                              <span className="anime-history-title">
                                {item.name}
                              </span>
                              <span className="anime-history-meta">
                                {`${timeAgo(item.savedAt)} · ${item.path}`}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="anime-history-del"
                              title="删除文件并移除记录"
                              onClick={() =>
                                void removeDownload(
                                  item
                                )
                              }
                            >
                              <DeleteOutlined />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {/* 本地页只显示列表，站点内容（板块/网格）一律不渲染 */}
                    {[
                      "resume",
                      "fav",
                      "downloads"
                    ].includes(
                      juzPath
                    ) ? null : juzPath === "" &&
                      juzSections.length ? (
                      <div className="anime-juz-scroll">
                        {juzSections.map(
                          section => (
                            <div
                              key={section.title}
                              className="anime-juz-section"
                            >
                              <p className="anime-juz-section-title">
                                {section.title}
                              </p>
                              <div className="anime-grid anime-grid--juz">
                                {section.videos.map(
                                  video => (
                                    <button
                                      key={
                                        video.id
                                      }
                                      className="anime-card"
                                      disabled={
                                        busy
                                      }
                                      title={
                                        video.title
                                      }
                                      onClick={() =>
                                        openDetail(
                                          video
                                        )
                                      }
                                    >
                                      <div className="anime-card-cover">
                                        {coverOf(
                                          video
                                        ) ? (
                                          <img
                                            src={coverOf(
                                              video
                                            )}
                                            alt={
                                              video.title
                                            }
                                            loading="lazy"
                                          />
                                        ) : (
                                          <span className="anime-card-fallback">
                                            {video.title.slice(
                                              0,
                                              1
                                            )}
                                          </span>
                                        )}
                                        {video.badgeTag && (
                                          <span className="anime-card-badge">
                                            {
                                              video.badgeTag
                                            }
                                          </span>
                                        )}
                                      </div>
                                      <p className="anime-card-title">
                                        {
                                          video.title
                                        }
                                      </p>
                                    </button>
                                  )
                                )}
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    ) : cards.length ? (
                      <div className="anime-juz-scroll">
                        <div className="anime-grid anime-grid--juz">
                          {cards.map(video => (
                            <button
                              key={video.id}
                              className="anime-card"
                              disabled={busy}
                              title={video.title}
                              onClick={() =>
                                openDetail(video)
                              }
                            >
                              <div className="anime-card-cover">
                                {coverOf(
                                  video
                                ) ? (
                                  <img
                                    src={coverOf(
                                      video
                                    )}
                                    alt={
                                      video.title
                                    }
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="anime-card-fallback">
                                    {video.title.slice(
                                      0,
                                      1
                                    )}
                                  </span>
                                )}
                                {video.badgeTag && (
                                  <span className="anime-card-badge">
                                    {
                                      video.badgeTag
                                    }
                                  </span>
                                )}
                              </div>
                              <p className="anime-card-title">
                                {video.title}
                              </p>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="anime-hint">
                        {busy
                          ? t("anime.loading")
                          : t("anime.empty")}
                      </p>
                    )}
                  </div>
                </div>
              ) : cards.length ? (
                <div className="anime-grid">
                  {cards.map(video => (
                    <button
                      key={video.id}
                      className="anime-card"
                      disabled={busy}
                      onClick={() =>
                        openDetail(video)
                      }
                    >
                      <div className="anime-card-cover">
                        {coverOf(video) ? (
                          <img
                            src={coverOf(video)}
                            alt={video.title}
                            loading="lazy"
                          />
                        ) : (
                          <span className="anime-card-fallback">
                            {video.title.slice(
                              0,
                              1
                            )}
                          </span>
                        )}
                      </div>
                      <p className="anime-card-title">
                        {video.title}
                      </p>
                      <p className="anime-card-sub">
                        {[
                          // 聚站卡片没有集数字段（角标文本已含「29集全」这类信息），
                          // 总集数缺失时不显示 0/0 占位
                          video.isFinished
                            ? t("anime.finished")
                            : video.totalEpisodes
                              ? `${video.currentEpisodes ?? 0}/${video.totalEpisodes}`
                              : "",
                          video.badgeTag ??
                            video.tags
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="anime-hint">
                  {busy
                    ? t("anime.loading")
                    : t("anime.empty")}
                </p>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
