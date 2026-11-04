/**
 * 直链播放器（H.264/VP9 片源）：mp4/flv 原生播，.m3u8 走 hls.js。
 *
 * m3u8 列表经 Rust `anime_fetch_text` 取回转 blob URL：对象存储不带 CORS，
 * 浏览器直接 fetch 会被拦（媒体元素不吃 CORS，所以列表要经后端取）。
 *
 * UI 走 CinemaControls（腾讯视频风格）；视频元素与事件在本组件持有。
 * 音频在走但没有帧（videoWidth===0 且播过 0.5s）时上报 onNoVideo，
 * 由外层做「软解/换清晰度」回退。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "@/shared/lib/log";
import { useT } from "@/settings/lib/i18n";
import { absolutizePlaylist } from "@/anime/lib/playlist";
import CinemaControls, {
  fmt,
  useCinemaHotkeys
} from "@/anime/components/CinemaControls";
import type { CinemaQualityOption } from "@/anime/components/CinemaControls";
import type { AnimeEpisode } from "@/anime/lib/types";

export default function VideoPlayer({
  src,
  title,
  onError,
  onNoVideo,
  qualities,
  activeQuality,
  onSelectQuality,
  episodes,
  activeEpisodeNum,
  onPlayEpisode,
  onBack,
  onNextEpisode,
  initialVolume,
  onVolumePersist,
  switching
}: {
  src: string;
  /** 顶部标题：「动漫名 · 集名」 */
  title: string;
  onError: (message: string) => void;
  /** 音频在播但解不出视频轨（多为 H.265 / 标错编码） */
  onNoVideo: () => void;
  qualities?: CinemaQualityOption[];
  activeQuality?: string;
  onSelectQuality?: (quality: string) => void;
  /** 选集菜单数据；为空不显示选集按钮 */
  episodes?: AnimeEpisode[];
  activeEpisodeNum?: number;
  onPlayEpisode?: (ep: AnimeEpisode) => void;
  onBack: () => void;
  /** 有下一集才渲染「下一集」按钮 */
  onNextEpisode?: () => void;
  /** 上次会话记住的音量（0..1），元数据加载后落到 video 上 */
  initialVolume?: number;
  /** 换集/换清晰度进行中：暂停交互并显示加载圈 */
  switching?: boolean;
  /** 音量变化（防抖在调用方做）：写盘持久化 */
  onVolumePersist?: (volume: number) => void;
}) {
  const t = useT();
  const videoRef =
    useRef<HTMLVideoElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(
    null
  );
  /** 同一条 src 只上报一次音频-only，避免每秒都触发换档 */
  const reportedRef = useRef(false);
  /** UI 状态（镜像到 CinemaControls 的 state） */
  const [playing, setPlaying] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<
    Array<[number, number]>
  >([]);
  const [volume, setVolume] = useState(
    initialVolume ?? 1
  );
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loopOn, setLoopOn] = useState(false);
  /** 外部提示浮条（截图/小窗）：nonce 保证同文案也能重弹 */
  const [hint, setHint] = useState<{
    text: string;
    nonce: number;
  } | null>(null);

  // —— 源装载：直链直挂 / m3u8 取回转 blob 后交给 hls.js ——
  useEffect(() => {
    reportedRef.current = false;
    let alive = true;
    // hls 实例的销毁跨 await 传递：同步 cleanup 只置标志，实例在回调里判活再毁
    let hls: { destroy: () => void } | null =
      null;
    let blobUrl = "";
    const video = videoRef.current;
    if (!video) return;
    if (!/\.m3u8($|\?)/i.test(src)) {
      // 直链 mp4/flv：媒体元素不吃 CORS，原生播就行
      video.src = src;
      return () => {
        video.removeAttribute("src");
      };
    }
    void (async () => {
      const { default: Hls } =
        await import("hls.js");
      if (!alive || !videoRef.current) return;
      if (!Hls.isSupported()) {
        // 老内核兜底：Safari 系才原生认 m3u8
        videoRef.current.src = src;
        return;
      }
      let listUrl = src;
      try {
        const text = await invoke<string>(
          "anime_fetch_text",
          { url: src }
        );
        blobUrl = URL.createObjectURL(
          new Blob(
            [absolutizePlaylist(text, src)],
            {
              type: "application/vnd.apple.mpegurl"
            }
          )
        );
        listUrl = blobUrl;
      } catch (reason) {
        logError(
          "[anime] 播放列表取回失败，退回直连",
          reason
        );
      }
      if (!alive || !videoRef.current) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      // 弱网防卡：默认主缓冲只有 30s，网络一抖就断流。这里把缓冲窗口
      // 拉到 3 分钟（上限 30 分钟 / 256MB，已播回退保留 90s），并预取
      // 首片、放宽分片重试——hls.js 内部按带宽自适应下载，无需自建缓存线程
      const instance = new Hls({
        maxBufferLength: 180,
        maxMaxBufferLength: 1800,
        maxBufferSize: 256 * 1000 * 1000,
        backBufferLength: 90,
        startFragPrefetch: true,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 500,
        fragLoadingMaxRetryTimeout: 16000
      });
      instance.loadSource(listUrl);
      instance.attachMedia(videoRef.current);
      hls = instance;
    })();
    return () => {
      alive = false;
      hls?.destroy();
      hls = null;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);

  // —— 视频操作（控制栏回调落地处） ——
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const applyVolume = useCallback(
    (v: number) => {
      const video = videoRef.current;
      if (!video) return;
      const next = Math.max(0, Math.min(1, v));
      video.volume = next;
      // 改音量即取消静音：静音下拖滑杆没反馈，用户只会以为坏了
      if (next > 0 && video.muted) {
        video.muted = false;
        setMuted(false);
      }
      setVolume(next);
      onVolumePersist?.(next);
    },
    [onVolumePersist]
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const applyRate = useCallback((r: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = r;
    setRate(r);
  }, []);

  const toggleLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.loop = !video.loop;
    setLoopOn(video.loop);
  }, []);

  const seek = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void root.requestFullscreen();
    }
  }, []);

  /** 截图：抓当前帧存 PNG（下载）。跨域污染的 canvas 会明确报错。 */
  const screenshot = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      setHint({
        text: t("anime.cin.shotFail"),
        nonce: Date.now()
      });
      return;
    }
    try {
      const canvas =
        document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas
        .getContext("2d")
        ?.drawImage(video, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) {
          setHint({
            text: t("anime.cin.shotFail"),
            nonce: Date.now()
          });
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        // 文件名里的路径非法字符换掉，时间戳点号保留
        a.download = `${title.replace(/[\\/:*?"<>|]/g, "_")}-${fmt(video.currentTime)}.png`;
        a.click();
        URL.revokeObjectURL(url);
        setHint({
          text: t("anime.cin.shotSaved"),
          nonce: Date.now()
        });
      }, "image/png");
    } catch {
      setHint({
        text: t("anime.cin.shotFail"),
        nonce: Date.now()
      });
    }
  }, [t, title]);

  const pip = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture();
      return;
    }
    video.requestPictureInPicture().catch(() => {
      setHint({
        text: t("anime.cin.pipFail"),
        nonce: Date.now()
      });
    });
  }, [t]);

  useCinemaHotkeys({
    onTogglePlay: togglePlay,
    onSkip: delta => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(
        0,
        Math.min(
          video.duration || Infinity,
          video.currentTime + delta
        )
      );
    },
    onVolumeDelta: delta =>
      applyVolume(
        (videoRef.current?.volume ?? 1) + delta
      ),
    onToggleMute: toggleMute,
    onToggleFullscreen: toggleFullscreen
  });

  // 换集/换源：软解记忆里的倍速等保持即可，只需重置上报标记（见上）

  return (
    <div ref={rootRef} className="cin-root">
      <video
        ref={videoRef}
        className="cin-video"
        autoPlay
        playsInline
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (!video) return;
          setCurrent(video.currentTime);
          const ranges = video.buffered;
          const segs: Array<[number, number]> =
            [];
          for (
            let i = 0;
            i < ranges.length;
            i += 1
          ) {
            segs.push([
              ranges.start(i),
              ranges.end(i)
            ]);
          }
          setBuffered(segs);
          if (
            !reportedRef.current &&
            video.currentTime > 0.5 &&
            video.videoWidth === 0
          ) {
            reportedRef.current = true;
            onNoVideo();
          }
        }}
        onLoadedMetadata={e => {
          setDuration(e.currentTarget.duration);
          const video = videoRef.current;
          if (
            video &&
            initialVolume !== undefined
          ) {
            video.volume = initialVolume;
          }
          if (video) {
            setVolume(video.volume);
            setMuted(video.muted);
            setRate(video.playbackRate);
            setLoopOn(video.loop);
          }
        }}
        onError={() =>
          onError(
            "视频加载失败（直链过期或格式不支持）"
          )
        }
      />
      <CinemaControls
        rootRef={rootRef}
        state={{
          title,
          playing,
          current,
          duration,
          buffered,
          volume,
          muted,
          rate,
          loopOn,
          switching: switching ?? false
        }}
        actions={{
          onTogglePlay: togglePlay,
          onSeek: seek,
          onVolume: applyVolume,
          onToggleMute: toggleMute,
          onRate: applyRate,
          onLoop: toggleLoop,
          onFullscreen: toggleFullscreen,
          onScreenshot: screenshot,
          onPip: pip,
          onBack,
          onNext: onNextEpisode
            ? () => {
                // 切下一集前先停住当前画面，切换窗口期不继续播旧集
                videoRef.current?.pause();
                onNextEpisode();
              }
            : undefined
        }}
        menus={{
          qualities,
          activeQuality,
          onSelectQuality,
          episodes,
          activeEpisodeNum,
          onPlayEpisode
        }}
        hint={hint}
      />
    </div>
  );
}
