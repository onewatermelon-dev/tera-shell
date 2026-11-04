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
  saveAnimeConfig
} from "@/anime/lib/store";
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
  } | null>(null);

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

  /** 音量变化持久化（防抖 300ms）：整体覆盖 anime.json，带上当前域名。 */
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
          void saveAnimeConfig({
            baseUrl,
            volume
          }).catch(reason =>
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

  function search() {
    if (!query.trim()) return;
    void run(async () => {
      const keyword = query.trim();
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

  /**
   * 参考站同名线路合并：详情打开后按标题在参考站搜索，标题完全一致才采用
   * （防止同名前缀误合并成另一部剧的剧集），命中就把它的剧集作为「优选线路」
   * 插到线路列表最前；用户还没手动选过线路时自动切过去。
   *
   * 参考站没配域名 / 接口挂了 / 没搜到都静默跳过，不影响聚站主流程。
   */
  async function mergeAppLine(
    title: string,
    juzLines: JuzLine[]
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
      if (!lineTouched.current) {
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

  /** 进详情页：聚站解析一页拿全部线路（参考站同名线路后台异步合并）；搜索结果里点参考站条目走加密 API 详情链路。 */
  function openDetail(video: AnimeVideo) {
    if (video.origin === "app") {
      void run(async () => {
        const [info, ep] = await Promise.all([
          animeApi<
            ApiEnvelope & { video?: AnimeDetail }
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
        setEpisodes(ep.episodes ?? []);
      });
      return;
    }
    void run(async () => {
      const parsed = await juzDetail(video.id);
      lineTouched.current = false;
      setAppLineId(null);
      setDetail(parsed.video);
      setJuzLines(parsed.lines);
      setJuzLineIdx(0);
      setEpPage(0);
      setEpisodes(
        parsed.lines[0]?.episodes ?? []
      );
      await mergeAppLine(
        parsed.video.title,
        parsed.lines
      );
    });
  }

  /**
   * 播一集：后端 anime_play 一次性完成整条播放链。
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
      // 参考站优选线路：走加密 API 播放链（与聚站解析互不相干）
      void run(async () => {
        const result = await invoke<{
          playUrl?: string;
          quality?: string;
          qualities?: CinemaQualityOption[];
          vcodec?: string;
        }>("anime_play", {
          baseUrl,
          videoId: appLineId,
          code: episode.code ?? "",
          episodeNum: episode.episodeNum,
          quality: quality ?? null
        });
        const playUrl = String(
          result.playUrl ?? ""
        );
        if (playUrl) {
          // 用户主动起播（没指定清晰度）时重置回退链
          if (!quality)
            triedQualities.current = [];
          setPlaying({
            url: playUrl,
            label:
              episode.episodeName ||
              `第 ${episode.episodeNum} 集`,
            quality:
              result.quality ?? quality ?? "",
            qualities: result.qualities ?? [],
            vcodec: result.vcodec ?? "",
            episode
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
      return;
    }
    // 聚站：用当前选中的线路播。player_data 里的 url 有三种形态——
    // 明文直链直接播；dujia* 解析源的加密 token 走 juzResolveToken 换真实
    // 地址；qq 等网页链接既非直链也解不了，明确报错提示换线。
    void run(async () => {
      const playPath = episode.code ?? "";
      if (
        !/^\/vodplay\/\d+-\d+-\d+\/$/.test(
          playPath
        )
      ) {
        throw new Error("这一集没有播放地址");
      }
      const { playUrl: raw } =
        await juzPlay(playPath);
      const playUrl = isDirectPlayUrl(raw)
        ? raw
        : await juzResolveToken(raw);
      setPlaying({
        url: playUrl,
        label:
          episode.episodeName ||
          `第 ${episode.episodeNum} 集`,
        quality: "",
        qualities: [],
        vcodec: "",
        episode
      });
      setSoftDecode(false);
    });
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
                      onPress={search}
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
                      {detail.actors ? (
                        <p className="anime-line anime-clamp">
                          {detail.actors}
                        </p>
                      ) : null}
                      {detail.description ? (
                        <p className="anime-line anime-clamp">
                          {detail.description}
                        </p>
                      ) : null}
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
                  <p className="anime-section-label">
                    {t("anime.episodes")}
                  </p>
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
                              className="anime-episode-chip"
                              disabled={busy}
                              onClick={() =>
                                play(episode)
                              }
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
                  </div>
                  <div className="anime-juz-main">
                    {/* 切频道/筛选加载中：半透明罩盖住旧内容 + 转圈 */}
                    {busy && (
                      <div className="anime-juz-loading">
                        <div className="cin-spin" />
                      </div>
                    )}
                    {juzScreens.map(group => (
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
                    {juzPath === "" &&
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
