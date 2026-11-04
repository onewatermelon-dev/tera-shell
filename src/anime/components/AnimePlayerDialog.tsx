/**
 * 动漫播放弹层：浏览（首页模块/搜索）→ 详情页 → 播放器。
 *
 * 请求链路复刻参考 App（com.yy.myuko 逆向结果，见 src-tauri/src/anime.rs）：
 * home/recommend / video/search / video/detail / resolve/episodes / resolve/sign。
 * API 域名由用户配置（参考 App 运行时才解密下发，静态拿不到）。
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

/** 卡片图：poster 优先（竖版海报，动漫站惯例），cover 兜底。 */
function coverOf(video: AnimeVideo): string {
  return video.posterUrl || video.coverUrl || "";
}

/**
 * 筛选组一行：chips 横向滚动（只显示一行），右侧 ‹ › 箭头按屏翻动，
 * 滚到两端时对应箭头置灰。
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
  /** 边界状态：决定左右箭头置灰 */
  const [edge, setEdge] = useState({
    left: false,
    right: false
  });

  const updateEdge = () => {
    const el = stripRef.current;
    if (!el) return;
    setEdge({
      left: el.scrollLeft > 4,
      right:
        el.scrollLeft + el.clientWidth <
        el.scrollWidth - 4
    });
  };

  // 挂载/内容变化后先算一次边界（选项数不同，溢出情况不同）
  useEffect(() => {
    updateEdge();
  });

  return (
    <div className="anime-screen-row">
      <span className="anime-screen-label">
        {label}
      </span>
      <div
        ref={stripRef}
        className="anime-screen-strip"
        onScroll={updateEdge}
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
      <button
        type="button"
        className="cin-ep-arrow"
        disabled={!edge.left}
        onClick={() =>
          stripRef.current?.scrollBy({
            left: -240,
            behavior: "smooth"
          })
        }
      >
        <LeftOutlined />
      </button>
      <button
        type="button"
        className="cin-ep-arrow"
        disabled={!edge.right}
        onClick={() =>
          stripRef.current?.scrollBy({
            left: 240,
            behavior: "smooth"
          })
        }
      >
        <RightOutlined />
      </button>
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
  const [configReady, setConfigReady] =
    useState(false);
  /** 数据源站点：app=参考站（加密 API），juz=聚站（网页解析） */
  const [source, setSource] = useState<
    "app" | "juz"
  >("app");
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
  /** 上次会话的音量（anime.json），新播放器起播时应用 */
  const [savedVolume, setSavedVolume] =
    useState(1);
  /** 详情页选集分页：每页 30 集，页签一行 + 箭头翻页 */
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

  /** 首页模块：失败不弹窗（很多源要求登录/域名不对），落横幅即可。 */
  const loadModules = useCallback(
    (host: string) =>
      run(async () => {
        const data = await animeApi<
          ApiEnvelope & {
            modules?: AnimeModule[];
          }
        >(host, ENDPOINTS.home, {});
        setBrowse({
          modules: data.modules ?? [],
          videos: []
        });
      }),
    [run]
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
        setSource(config.site ?? "app");
        setSavedVolume(config.volume ?? 1);
        setConfigReady(true);
        if (config.site === "juz") {
          void loadJuzHome();
        } else if (config.baseUrl) {
          void loadModules(config.baseUrl);
        }
      } catch (reason) {
        logError("[anime] 读配置失败", reason);
        if (alive) setConfigReady(true);
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
  }, [loadModules, loadJuzHome]);

  /** 音量变化持久化（防抖 300ms）：整体覆盖 anime.json，带上当前域名/站点。 */
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
            site: source,
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
    [baseUrl, source]
  );

  /** 切数据源：清空浏览/详情/播放态，配置落盘（下次打开记住选择）。 */
  function switchSource(next: "app" | "juz") {
    if (next === source) return;
    setSource(next);
    setBrowse(null);
    setDetail(null);
    setEpisodes([]);
    setPlaying(null);
    setError("");
    void saveAnimeConfig({
      baseUrl,
      site: next
    }).catch(reason =>
      logError("[anime] 保存站点选择失败", reason)
    );
    if (next === "juz") {
      void loadJuzHome();
    } else if (baseUrl) {
      void loadModules(baseUrl);
    }
  }

  function search() {
    if (!query.trim()) return;
    if (source === "juz") {
      void run(async () => {
        setBrowse({
          modules: [],
          videos: await juzSearch(query.trim())
        });
      });
      return;
    }
    void run(async () => {
      const data = await animeApi<
        ApiEnvelope & { videos?: AnimeVideo[] }
      >(baseUrl, ENDPOINTS.search, {
        keyword: query.trim(),
        pageIndex: 1,
        pageSize: 30
      });
      setBrowse({
        modules: [],
        videos: data.videos ?? []
      });
    });
  }

  /** 进详情页：详情 + 剧集并行拉（参考站两个接口并行；聚站解析一页拿全部线路）。 */
  function openDetail(video: AnimeVideo) {
    if (source === "juz") {
      void run(async () => {
        const parsed = await juzDetail(video.id);
        setDetail(parsed.video);
        setJuzLines(parsed.lines);
        setJuzLineIdx(0);
        setEpPage(0);
        setEpisodes(
          parsed.lines[0]?.episodes ?? []
        );
      });
      return;
    }
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
      setDetail(
        info.video ?? {
          ...video,
          description: ""
        }
      );
      setEpisodes(ep.episodes ?? []);
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
    if (source === "juz") {
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
      return;
    }
    void run(async () => {
      const result = await invoke<{
        playUrl?: string;
        quality?: string;
        qualities?: CinemaQualityOption[];
        vcodec?: string;
      }>("anime_play", {
        baseUrl,
        videoId: detail.id,
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
                  {/* 数据源切换：参考站（加密 API，需配域名）/ 聚站（网页解析，开箱即用） */}
                  <div className="anime-source-row">
                    <button
                      type="button"
                      className={
                        "anime-source-chip" +
                        (source === "app"
                          ? " is-active"
                          : "")
                      }
                      disabled={busy}
                      onClick={() =>
                        switchSource("app")
                      }
                    >
                      {t("anime.sourceApp")}
                    </button>
                    <button
                      type="button"
                      className={
                        "anime-source-chip" +
                        (source === "juz"
                          ? " is-active"
                          : "")
                      }
                      disabled={busy}
                      onClick={() =>
                        switchSource("juz")
                      }
                    >
                      {t("anime.sourceJuz")}
                    </button>
                  </div>
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
                      isDisabled={
                        busy ||
                        (source === "app" &&
                          !baseUrl)
                      }
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
                  {playing.vcodec
                    ?.toUpperCase()
                    .includes("265") && (
                    <p className="anime-hint anime-hevc-hint">
                      {t("anime.hevcHint")}
                    </p>
                  )}
                  {softDecode && (
                    <p className="anime-hint anime-hevc-hint">
                      {t("anime.softDecode")}
                    </p>
                  )}
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
                  {source === "juz" &&
                    juzLines.length > 1 && (
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
                              // 悬停显示站点原名（「剧踪独家[热播X]」这类营销名），
                              // 按钮上是自定义的简洁名 + 集数
                              title={line.title}
                              onClick={() => {
                                setJuzLineIdx(
                                  index
                                );
                                setEpPage(0);
                                setEpisodes(
                                  line.episodes
                                );
                              }}
                            >
                              {`线路 ${index + 1} · ${line.episodes.length}集`}
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
                                  onClick={() =>
                                    setEpPage(i)
                                  }
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
                          <button
                            type="button"
                            className="cin-ep-arrow"
                            disabled={
                              epPage === 0
                            }
                            onClick={() =>
                              setEpPage(p =>
                                Math.max(0, p - 1)
                              )
                            }
                          >
                            <LeftOutlined />
                          </button>
                          <button
                            type="button"
                            className="cin-ep-arrow"
                            disabled={
                              epPage >=
                              Math.ceil(
                                episodes.length /
                                  EP_PAGE_SIZE
                              ) -
                                1
                            }
                            onClick={() =>
                              setEpPage(p =>
                                Math.min(
                                  Math.ceil(
                                    episodes.length /
                                      EP_PAGE_SIZE
                                  ) - 1,
                                  p + 1
                                )
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
              ) : source === "juz" &&
                juzNav.length ? (
                // 聚站浏览页：左侧频道栏 + 筛选 chips + 大卡网格（腾讯视频排版）
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
                    : source === "juz" ||
                        (configReady && baseUrl)
                      ? t("anime.empty")
                      : t("anime.hostHint")}
                </p>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
