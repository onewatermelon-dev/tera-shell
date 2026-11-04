/**
 * 影院控制栏（对标腾讯视频网页端，直链/软解两个播放器共用）：
 *
 * - 顶部渐变条：返回 + 「动漫名 · 集名」
 * - 进度行：当前/总时长 + 自绘轨道（缓存段、红色已播、hover 气泡、拖拽 seek）
 * - 按钮行：播放/下一集/弹幕开关 | 选集/倍速 ‖ 清晰度/音量/设置/截图/小窗/铺满/全屏
 * - 弹出菜单：选集网格、倍速档位、清晰度、音量滑杆、设置（循环+快捷键说明）
 * - 中央暂停按钮、操作提示浮条
 * - 鼠标静置 2.6s 自动隐藏（播放中且无菜单/拖拽时）
 *
 * 本组件只管 UI：视频元素与事件由调用方持有，通过 actions/menus 回调驱动。
 */
import {
  useEffect,
  useRef,
  useState
} from "react";
import {
  ArrowLeftOutlined,
  CameraOutlined,
  LeftOutlined,
  RightOutlined,
  CaretRightFilled,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PauseOutlined,
  SettingOutlined,
  SoundFilled,
  SoundOutlined,
  StepForwardFilled,
  SwitcherOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import type { AnimeEpisode } from "@/anime/lib/types";

/** 秒 → mm:ss（分钟补零，腾讯同款）/ h:mm:ss。 */
export function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return "00:00";
  }
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** 倍速档位（腾讯同款 0.5~3）。 */
export const RATES = [
  0.5, 0.75, 1, 1.25, 1.5, 2, 3
];

/** 选集每页集数（播放器菜单与详情页网格共用；超过则分段页签）。 */
export const EP_PAGE_SIZE = 30;

/** 选集菜单里的单集按钮（分页与否共用一片渲染）。 */
function EpChip({
  ep,
  active,
  onPick
}: {
  ep: AnimeEpisode;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={
        "cin-ep-chip" +
        (active ? " is-active" : "")
      }
      title={
        ep.episodeName || `第 ${ep.episodeNum} 集`
      }
      onClick={onPick}
    >
      {ep.episodeName || ep.episodeNum}
    </button>
  );
}

/** 清晰度选项（服务端原样回传 + 会员档标记）。 */
export type CinemaQualityOption = {
  quality: string;
  label: string;
  isVipOnly?: boolean;
};

/** 控制栏渲染所需的播放状态（由播放器每次渲染时收集）。 */
export type CinemaState = {
  title: string;
  playing: boolean;
  current: number;
  duration: number;
  buffered: Array<[number, number]>;
  volume: number;
  muted: boolean;
  rate: number;
  loopOn: boolean;
  /** 换集/换清晰度进行中：暂停交互 + 显示加载圈 */
  switching: boolean;
};

/** 控制栏触发的行为回调（视频操作全部在播放器里落地）。 */
export type CinemaActions = {
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onRate: (r: number) => void;
  onLoop: () => void;
  onFullscreen: () => void;
  onScreenshot: () => void;
  onPip: () => void;
  onBack: () => void;
  onNext?: () => void;
};

/** 选集 / 清晰度两组菜单数据。 */
export type CinemaMenus = {
  qualities?: CinemaQualityOption[];
  activeQuality?: string;
  onSelectQuality?: (q: string) => void;
  episodes?: AnimeEpisode[];
  activeEpisodeNum?: number;
  onPlayEpisode?: (ep: AnimeEpisode) => void;
};

/** 外部提示（截图已保存这类）：text + nonce 触发一次显示。 */
export type CinemaHint = {
  text: string;
  nonce: number;
} | null;

type MenuKind =
  | "episodes"
  | "speed"
  | "quality"
  | "volume"
  | "settings"
  | null;

/**
 * 全局快捷键（Space/←→/↑↓/F/M），两个播放器行为一致，收口在这里。
 * 输入框聚焦时不抢键；浏览器级快捷键已被应用禁用（lib.rs），不冲突。
 */
export function useCinemaHotkeys(handlers: {
  onTogglePlay: () => void;
  onSkip: (delta: number) => void;
  onVolumeDelta: (delta: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target =
        e.target as HTMLElement | null;
      if (
        target &&
        (/^(input|textarea|select)$/i.test(
          target.tagName
        ) ||
          target.isContentEditable)
      ) {
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          handlers.onTogglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          handlers.onSkip(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          handlers.onSkip(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          handlers.onVolumeDelta(0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          handlers.onVolumeDelta(-0.1);
          break;
        case "KeyM":
          handlers.onToggleMute();
          break;
        case "KeyF":
          handlers.onToggleFullscreen();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(
        "keydown",
        onKey
      );
    };
  }, [handlers]);
}

/**
 * 影院控制栏。`rootRef` 是播放器根容器（.cin-root），本组件把
 * 鼠标活动/离开监听挂在上面驱动自动隐藏。
 */
export default function CinemaControls({
  rootRef,
  state,
  actions,
  menus,
  hint
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  state: CinemaState;
  actions: CinemaActions;
  menus: CinemaMenus;
  hint?: CinemaHint;
}) {
  const t = useT();
  const uiRef = useRef<HTMLDivElement | null>(
    null
  );
  const trackRef = useRef<HTMLDivElement | null>(
    null
  );
  /** 控制栏可见性（鼠标静置自动隐藏；暂停/菜单/拖拽时由派生值兜底常亮） */
  const [idle, setIdle] = useState(false);
  const hideTimer = useRef<number | null>(null);
  /** 当前展开的菜单（同时只开一个） */
  const [menu, setMenu] =
    useState<MenuKind>(null);
  /** 进度条拖拽 + hover 预览 */
  const [scrubbing, setScrubbing] =
    useState(false);
  const [hoverT, setHoverT] = useState<
    number | null
  >(null);
  const [hoverPct, setHoverPct] = useState(0);
  /** 音量竖条拖拽中（down/move 实时调音量，与进度条「松手才 seek」不同） */
  const [volDragging, setVolDragging] =
    useState(false);
  const volTrackRef =
    useRef<HTMLDivElement | null>(null);
  /**
   * seek 锁定：松手时的目标时间。hls 换取新片段的窗口期里
   * video.currentTime 可能被拉回旧帧，进度条若直接跟 current 会闪回——
   * 显示层先钉在目标位置，等播放真的到达（差值 <0.75s 或缓冲已覆盖）再放行
   */
  const [pendingSeek, setPendingSeek] = useState<
    number | null
  >(null);
  /** 选集分页：每页 30 集，页签「1-30 / 31-60」（腾讯同款段选） */
  const [epPage, setEpPage] = useState(0);
  /** 页签条（横向滚动容器）：激活页签变化时滚进视野 */
  const epTabsRef = useRef<HTMLDivElement | null>(
    null
  );
  /** 音量 wrapper：滚轮监听要非 passive 才能 preventDefault（React 合成 onWheel 无效） */
  const volWrapRef =
    useRef<HTMLDivElement | null>(null);
  /** 本组件触发的操作提示（切倍速/音量/弹幕等） */
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  /** 原生全屏状态（图标切换用） */
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const onFs = () => {
      setFs(Boolean(document.fullscreenElement));
    };
    document.addEventListener(
      "fullscreenchange",
      onFs
    );
    return () => {
      document.removeEventListener(
        "fullscreenchange",
        onFs
      );
    };
  }, []);

  /** 显示提示浮条 1.8s；同组定时器先清，连续操作不串台。 */
  const show = (text: string) => {
    setToast(text);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(
      () => setToast(""),
      1800
    );
  };

  // 外部提示（截图/小窗）：nonce 变化即弹一次
  const lastNonce = useRef(0);
  useEffect(() => {
    if (
      hint &&
      hint.nonce !== lastNonce.current
    ) {
      lastNonce.current = hint.nonce;
      show(hint.text);
    }
  }, [hint]);

  /**
   * 每次鼠标交互统一走这里：先显示，再重挂 3s 静置定时器。
   * 鼠标停在播放器里不动 3s 后置 idle；移出播放器由 pointerleave 立即置 idle。
   * 是否真隐藏由下面的派生值决定（暂停/菜单/拖拽中常亮）。
   */
  const poke = () => {
    setIdle(false);
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
    }
    hideTimer.current = window.setTimeout(
      () => setIdle(true),
      3000
    );
  };

  // 鼠标活动 → poke（显示 + 重挂定时器）；离开播放器 → 立刻隐藏
  // （暂停/菜单/拖拽中的常亮由派生值兜底，不怕误藏）
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onLeave = () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
      setIdle(true);
    };
    root.addEventListener("pointermove", poke);
    root.addEventListener(
      "pointerleave",
      onLeave
    );
    return () => {
      root.removeEventListener(
        "pointermove",
        poke
      );
      root.removeEventListener(
        "pointerleave",
        onLeave
      );
    };
  });

  // 音量滑条上的滚轮：上滚 +5%、下滚 -5%；静音状态下滚动顺带解除静音
  useEffect(() => {
    const wrap = volWrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.05 : -0.05;
      actions.onVolume(
        (state.muted ? 0 : state.volume) + step
      );
    };
    wrap.addEventListener("wheel", onWheel, {
      passive: false
    });
    return () => {
      wrap.removeEventListener("wheel", onWheel);
    };
  });

  // 翻页/定位后把激活页签滚进页签条视野（横向，不抢页面滚动）
  useEffect(() => {
    if (menu !== "episodes") return;
    const active =
      epTabsRef.current?.querySelector(
        ".cin-ep-tab.is-active"
      );
    active?.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
  });

  // 派生可见性：暂停中 / 菜单开着 / 拖拽进度中一律常亮，
  // 省掉随 playing/menu/scrubbing 变化同步 setState 的 effect
  const visible =
    !idle ||
    !state.playing ||
    menu !== null ||
    scrubbing;

  // —— 进度条：位置换算 + 拖拽（松手才 seek，拖拽中只动预览） ——
  const timeAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || state.duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const ratio =
      (clientX - rect.left) / rect.width;
    return Math.max(
      0,
      Math.min(
        state.duration,
        ratio * state.duration
      )
    );
  };
  const pctAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        100,
        ((clientX - rect.left) / rect.width) * 100
      )
    );
  };
  /** 音量竖条：鼠标纵坐标 → 0..1（上大下小）。 */
  const volAt = (clientY: number) => {
    const track = volTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    actions.onVolume(
      Math.max(
        0,
        Math.min(
          1,
          1 - (clientY - rect.top) / rect.height
        )
      )
    );
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // 捕获指针：拖出轨道也持续收 move，松手前不丢事件
    (
      e.currentTarget as HTMLElement
    ).setPointerCapture(e.pointerId);
    setScrubbing(true);
    setHoverT(timeAt(e.clientX));
    setHoverPct(pctAt(e.clientX));
  };
  const onMove = (e: React.PointerEvent) => {
    setHoverT(timeAt(e.clientX));
    setHoverPct(pctAt(e.clientX));
  };
  const onUp = () => {
    setScrubbing(false);
    if (hoverT !== null) {
      // 目标与当前位置几乎重合就不锁（避免一闪而过的 loading）
      if (
        Math.abs(hoverT - state.current) > 0.5
      ) {
        setPendingSeek(hoverT);
      }
      actions.onSeek(hoverT);
    }
    setHoverT(null);
  };

  // seek 锁定是否仍生效：目标既没进缓冲、播放点也没贴到 → 进度条钉在目标位置
  const seekLocking =
    pendingSeek !== null &&
    !state.buffered.some(
      ([start, end]) =>
        pendingSeek >= start && pendingSeek <= end
    ) &&
    Math.abs(state.current - pendingSeek) >= 0.75;
  const shown = scrubbing
    ? (hoverT ?? state.current)
    : seekLocking
      ? pendingSeek
      : state.current;
  const pct =
    state.duration > 0
      ? (shown / state.duration) * 100
      : 0;

  // 清晰度展示名（按钮上的「1080P 高清」）
  const activeQ =
    menus.qualities?.find(
      o => o.quality === menus.activeQuality
    ) ?? null;
  const rateLabel =
    state.rate === 1
      ? t("anime.cin.speed")
      : `${state.rate.toFixed(state.rate % 1 ? 2 : 0)}x`;

  return (
    <div
      ref={uiRef}
      className={
        "cin-ui" + (visible ? "" : " is-hidden")
      }
      onPointerDown={poke}
    >
      {/* 顶部：返回 + 标题 */}
      <div className="cin-top">
        <button
          type="button"
          className="cin-top-back"
          title={t("anime.back")}
          onClick={actions.onBack}
        >
          <ArrowLeftOutlined />
        </button>
        <p className="cin-top-title">
          {state.title}
        </p>
      </div>

      {/* 进度区：两端时间（左当前/右总长）+ 下方全宽轨道 */}
      <div className="cin-bottom">
        {/* 切换中：透明遮罩拦掉进度条/按钮的全部点击 */}
        {state.switching && (
          <div className="cin-mask" />
        )}
        <div className="cin-progress">
          <div className="cin-times">
            <span className="cin-time">
              {fmt(shown)}
            </span>
            <span className="cin-time">
              {fmt(state.duration)}
            </span>
          </div>
          <div
            ref={trackRef}
            className={
              "cin-track" +
              (scrubbing ? " is-scrub" : "")
            }
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={() => {
              if (!scrubbing) setHoverT(null);
            }}
          >
            {hoverT !== null && (
              <div
                className="cin-tip"
                style={{ left: `${hoverPct}%` }}
              >
                {fmt(hoverT)}
              </div>
            )}
            <div className="cin-rail" />
            {state.buffered.map(([s, e], i) => (
              <div
                key={i}
                className="cin-seg"
                style={{
                  left: `${(s / state.duration) * 100}%`,
                  width: `${((e - s) / state.duration) * 100}%`
                }}
              />
            ))}
            <div
              className="cin-played"
              style={{ width: `${pct}%` }}
            />
            <div
              className="cin-thumb"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>

        {/* 按钮行 */}
        <div className="cin-row">
          <button
            type="button"
            className="cin-btn"
            title={
              state.playing
                ? t("anime.cin.pause")
                : t("anime.cin.play")
            }
            onClick={actions.onTogglePlay}
          >
            {state.playing ? (
              <PauseOutlined />
            ) : (
              <CaretRightFilled />
            )}
          </button>
          {actions.onNext && (
            <button
              type="button"
              className="cin-btn"
              title={t("anime.cin.next")}
              onClick={actions.onNext}
            >
              <StepForwardFilled />
            </button>
          )}
          {/* 只有一集没有切换的意义（电影/蓝光），不渲染选集入口 */}
          {menus.episodes &&
            menus.episodes.length > 1 &&
            menus.onPlayEpisode && (
              <div
                className="cin-item"
                onMouseEnter={() => {
                  setMenu("episodes");
                  // 定位到当前集所在段；没有当前集就落第 0 段
                  const eps =
                    menus.episodes ?? [];
                  const activeIdx = eps.findIndex(
                    ep =>
                      ep.episodeNum ===
                      menus.activeEpisodeNum
                  );
                  setEpPage(
                    activeIdx >= 0
                      ? Math.floor(
                          activeIdx / EP_PAGE_SIZE
                        )
                      : 0
                  );
                }}
                onMouseLeave={() => {
                  if (menu === "episodes")
                    setMenu(null);
                }}
              >
                <button
                  type="button"
                  className="cin-txt"
                >
                  {t("anime.episodes")}
                </button>
                {menu === "episodes" && (
                  <div className="cin-item-pop cin-item-pop--l">
                    {(() => {
                      const eps =
                        menus.episodes ?? [];
                      const pageCount = Math.ceil(
                        eps.length / EP_PAGE_SIZE
                      );
                      // 集数没超一页就直接平铺，不出页签
                      if (pageCount <= 1) {
                        return (
                          <div className="cin-ep-grid">
                            {eps.map(ep => (
                              <EpChip
                                key={
                                  ep.episodeNum
                                }
                                ep={ep}
                                active={
                                  ep.episodeNum ===
                                  menus.activeEpisodeNum
                                }
                                onPick={() => {
                                  setMenu(null);
                                  menus.onPlayEpisode?.(
                                    ep
                                  );
                                }}
                              />
                            ))}
                          </div>
                        );
                      }
                      const page = Math.min(
                        epPage,
                        pageCount - 1
                      );
                      const slice = eps.slice(
                        page * EP_PAGE_SIZE,
                        (page + 1) * EP_PAGE_SIZE
                      );
                      return (
                        <>
                          <div className="cin-ep-tabs-row">
                            <div
                              ref={epTabsRef}
                              className="cin-ep-tabs"
                            >
                              {Array.from(
                                {
                                  length:
                                    pageCount
                                },
                                (_, i) => (
                                  <button
                                    key={i}
                                    type="button"
                                    className={
                                      "cin-ep-tab" +
                                      (i === page
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
                                      eps.length
                                    )}
                                  </button>
                                )
                              )}
                            </div>
                            {/* 箭头翻页：上一段/下一段，边界置灰 */}
                            <button
                              type="button"
                              className="cin-ep-arrow"
                              disabled={
                                page === 0
                              }
                              onClick={() =>
                                setEpPage(p =>
                                  Math.max(
                                    0,
                                    p - 1
                                  )
                                )
                              }
                            >
                              <LeftOutlined />
                            </button>
                            <button
                              type="button"
                              className="cin-ep-arrow"
                              disabled={
                                page ===
                                pageCount - 1
                              }
                              onClick={() =>
                                setEpPage(p =>
                                  Math.min(
                                    pageCount - 1,
                                    p + 1
                                  )
                                )
                              }
                            >
                              <RightOutlined />
                            </button>
                          </div>
                          <div className="cin-ep-grid">
                            {slice.map(ep => (
                              <EpChip
                                key={
                                  ep.episodeNum
                                }
                                ep={ep}
                                active={
                                  ep.episodeNum ===
                                  menus.activeEpisodeNum
                                }
                                onPick={() => {
                                  setMenu(null);
                                  menus.onPlayEpisode?.(
                                    ep
                                  );
                                }}
                              />
                            ))}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          <div
            className="cin-item"
            onMouseEnter={() => setMenu("speed")}
            onMouseLeave={() => {
              if (menu === "speed") setMenu(null);
            }}
          >
            <button
              type="button"
              className="cin-txt"
            >
              {rateLabel}
            </button>
            {menu === "speed" && (
              <div className="cin-item-pop">
                {RATES.map(rate => (
                  <button
                    key={rate}
                    type="button"
                    className={
                      "cin-pop-item" +
                      (rate === state.rate
                        ? " is-active"
                        : "")
                    }
                    onClick={() => {
                      setMenu(null);
                      actions.onRate(rate);
                      show(
                        t(
                          "anime.cin.speedSet"
                        ).replace(
                          "{x}",
                          String(rate)
                        )
                      );
                    }}
                  >
                    {rate === 1
                      ? "1.0x 常速"
                      : `${rate}x`}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="cin-spacer" />
          {activeQ && (
            <div
              className="cin-item"
              onMouseEnter={() =>
                setMenu("quality")
              }
              onMouseLeave={() => {
                if (menu === "quality")
                  setMenu(null);
              }}
            >
              <button
                type="button"
                className="cin-txt"
              >
                {activeQ.label || activeQ.quality}
              </button>
              {menu === "quality" &&
                menus.qualities && (
                  <div className="cin-item-pop">
                    {menus.qualities.map(
                      option => (
                        <button
                          key={option.quality}
                          type="button"
                          className={
                            "cin-pop-item" +
                            (option.quality ===
                            menus.activeQuality
                              ? " is-active"
                              : "") +
                            (option.isVipOnly
                              ? " is-vip"
                              : "")
                          }
                          title={
                            option.isVipOnly
                              ? t("anime.vipOnly")
                              : undefined
                          }
                          onClick={() => {
                            if (option.isVipOnly)
                              return;
                            setMenu(null);
                            menus.onSelectQuality?.(
                              option.quality
                            );
                          }}
                        >
                          {option.isVipOnly
                            ? "🔒 "
                            : ""}
                          {option.label ||
                            option.quality}
                        </button>
                      )
                    )}
                  </div>
                )}
            </div>
          )}
          {/* 音量：悬停弹竖向滑条，点击静音/恢复（muted 不动 volume，恢复即原音量） */}
          <div
            ref={volWrapRef}
            className="cin-vol"
            onMouseEnter={() => setMenu("volume")}
            onMouseLeave={() => {
              if (menu === "volume")
                setMenu(null);
            }}
          >
            <button
              type="button"
              className="cin-btn"
              title={
                state.muted || state.volume === 0
                  ? t("anime.cin.unmute")
                  : t("anime.cin.mute")
              }
              onClick={actions.onToggleMute}
            >
              {state.muted ||
              state.volume === 0 ? (
                <SoundOutlined />
              ) : (
                <SoundFilled />
              )}
            </button>
            {menu === "volume" && (
              <div className="cin-vol-pop">
                <span className="cin-vol-num">
                  {Math.round(
                    (state.muted
                      ? 0
                      : state.volume) * 100
                  )}
                </span>
                <div
                  ref={volTrackRef}
                  className="cin-vol-track"
                  onPointerDown={e => {
                    e.preventDefault();
                    (
                      e.currentTarget as HTMLElement
                    ).setPointerCapture(
                      e.pointerId
                    );
                    setVolDragging(true);
                    volAt(e.clientY);
                  }}
                  onPointerMove={e => {
                    if (volDragging)
                      volAt(e.clientY);
                  }}
                  onPointerUp={() =>
                    setVolDragging(false)
                  }
                >
                  <div
                    className="cin-vol-fill"
                    style={{
                      height: `${(state.muted ? 0 : state.volume) * 100}%`
                    }}
                  />
                  <div
                    className="cin-vol-thumb"
                    style={{
                      bottom: `calc(${(state.muted ? 0 : state.volume) * 100}% - 6px)`
                    }}
                  />
                </div>
              </div>
            )}
          </div>
          <div
            className="cin-item"
            onMouseEnter={() =>
              setMenu("settings")
            }
            onMouseLeave={() => {
              if (menu === "settings")
                setMenu(null);
            }}
          >
            <button
              type="button"
              className="cin-btn"
              title={t("anime.cin.settings")}
            >
              <SettingOutlined />
            </button>
            {menu === "settings" && (
              <div className="cin-item-pop cin-item-pop--r">
                <div className="cin-set-row">
                  <span className="cin-set-label">
                    {t("anime.cin.loop")}
                  </span>
                  <input
                    type="checkbox"
                    className="cin-check"
                    checked={state.loopOn}
                    onChange={actions.onLoop}
                  />
                </div>
                <p className="cin-set-tip">
                  {t("anime.cin.shortcutHint")}
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            className="cin-btn"
            title={t("anime.cin.screenshot")}
            onClick={actions.onScreenshot}
          >
            <CameraOutlined />
          </button>
          <button
            type="button"
            className="cin-btn"
            title={t("anime.cin.pip")}
            onClick={actions.onPip}
          >
            <SwitcherOutlined />
          </button>
          <button
            type="button"
            className="cin-btn"
            title={
              fs
                ? t("anime.cin.exitFullscreen")
                : t("anime.cin.fullscreen")
            }
            onClick={actions.onFullscreen}
          >
            {fs ? (
              <FullscreenExitOutlined />
            ) : (
              <FullscreenOutlined />
            )}
          </button>
        </div>
      </div>

      {/* 中央暂停按钮 */}
      {!state.playing && (
        <div className="cin-center">
          <button
            type="button"
            className="cin-center-btn"
            onClick={actions.onTogglePlay}
          >
            <CaretRightFilled />
          </button>
        </div>
      )}

      {/* 切集加载圈：优先级高于 seek 圈（互斥场景不会同时出现） */}
      {state.switching && (
        <div className="cin-loading">
          <div className="cin-spin" />
        </div>
      )}

      {/* seek 加载圈：锁定期间新片段还没到位 */}
      {seekLocking && (
        <div className="cin-loading">
          <div className="cin-spin" />
        </div>
      )}

      {/* 操作提示浮条（内部 toast 统一入口，外部 hint 经 nonce 转入） */}
      {toast && (
        <div className="cin-toast">{toast}</div>
      )}
    </div>
  );
}
