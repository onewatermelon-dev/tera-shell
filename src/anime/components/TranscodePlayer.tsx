/**
 * 软解播放器：把 H.265 片源交给后端 ffmpeg 转成 H.264，前端用 MediaSource
 * 边收分片边播。
 *
 * ## 为什么需要它
 *
 * WebView2 默认不带 HEVC 解码器，H.265 的片子只有声音没有画面。系统装
 * 「HEVC 视频扩展」能解决，但不是每个人都有；这里用 ffmpeg 软解兜底。
 *
 * ## 数据通路
 *
 * ```
 * ffmpeg stdout(fMP4) → 64KB 分片 → base64 → 事件 → 这里解码 → MSE 追加
 * ```
 *
 * ## 时间轴模型
 *
 * 转码是单向流，输出时间戳**总是从 0 开始**（ffmpeg 的 `-ss` 输入侧定位，
 * 且 mp4 muxer 在 empty_moov 的 fMP4 下会把第一个 sample 时间戳归零，`-copyts`/
 * `-output_ts_offset`/`setpts` 都无效）。所以：
 *
 * - `startAt`：本段转码流对应源片的绝对起始秒数（拖动目标）。
 * - `<video>.currentTime`：相对本段流的时间，从 0 起。
 * - 源片绝对时间 = `startAt + currentTime`。
 *
 * 进度条始终显示**全集绝对时间轴**（0 .. total）；拖到未缓冲位置会重开转码
 * （杀旧 ffmpeg、从该点重起），期间抓最后一帧冻结 + 加载圈替代黑屏。
 * UI 走 CinemaControls（与直链播放器同一套腾讯风格控制栏）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "@/shared/lib/log";
import { useT } from "@/settings/lib/i18n";
import CinemaControls, {
  fmt,
  useCinemaHotkeys
} from "@/anime/components/CinemaControls";
import type { CinemaQualityOption } from "@/anime/components/CinemaControls";
import type { AnimeEpisode } from "@/anime/lib/types";

/** 后端转码分片事件（与 anime_transcode.rs 的 CHUNK_EVENT 一致）。 */
const CHUNK_EVENT = "anime://transcode-chunk";
/** 后端转码结束事件。 */
const END_EVENT = "anime://transcode-end";

/** MSE 的 MIME：h264 main@4.0 + aac-lc，与 ffmpeg 编码参数对应。 */
const MIME =
  'video/mp4; codecs="avc1.4d4028,mp4a.40.2"';

type ChunkPayload = {
  id: string;
  seq: number;
  chunk: string;
};
type EndPayload = { id: string; error: string };

/** base64 → 字节数组（分片是二进制，别用 TextDecoder 解）。 */
function decode(chunk: string): Uint8Array {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export default function TranscodePlayer({
  src,
  title,
  onError,
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
  qualities?: CinemaQualityOption[];
  activeQuality?: string;
  onSelectQuality?: (quality: string) => void;
  episodes?: AnimeEpisode[];
  activeEpisodeNum?: number;
  onPlayEpisode?: (ep: AnimeEpisode) => void;
  onBack: () => void;
  onNextEpisode?: () => void;
  /** 上次会话记住的音量（0..1），装流前直接落到 video 上 */
  initialVolume?: number;
  /** 换集/换清晰度进行中：暂停交互并显示加载圈 */
  switching?: boolean;
  /** 音量变化（防抖在调用方做）：写盘持久化 */
  onVolumePersist?: (volume: number) => void;
}) {
  const t = useT();
  const videoRef =
    useRef<HTMLVideoElement | null>(null);
  /** 全屏/铺满目标（根容器） */
  const rootRef = useRef<HTMLDivElement | null>(
    null
  );

  /**
   * 本段转码流对应的源片绝对起始秒数。拖动到未缓冲位置时更新，
   * 触发整条管线重建（杀旧 ffmpeg、从该位置重新起）。
   */
  const [startAt, setStartAt] = useState(0);
  /** 全集总时长（后端探测），进度条用绝对时间轴 0..total */
  const [total, setTotal] = useState(0);
  /** 绝对播放位置（startAt + video.currentTime），驱动进度条 */
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(true);
  /** 拖动重开转码期间，冻结最后一帧 + 显示加载圈（替代黑屏） */
  const [frozen, setFrozen] = useState(false);
  const [frozenUrl, setFrozenUrl] = useState("");
  const frozenRef = useRef(false);
  /** 缓存区间（绝对秒，多个不连续段） */
  const [buffered, setBuffered] = useState<
    Array<[number, number]>
  >([]);
  const [volume, setVolume] = useState(
    initialVolume ?? 1
  );
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loopOn, setLoopOn] = useState(false);
  const [hint, setHint] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  /** 保存外层滚动容器位置：拖动重开转码时 video 短暂卸载会抖动滚动，
   *  在重建前后保持 scrollTop 不变。 */
  const scrollTopRef = useRef<number | null>(
    null
  );

  /** 抓当前 video 一帧，作为重开转码期间的冻结画面。 */
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    try {
      const canvas =
        document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas
        .getContext("2d")
        ?.drawImage(video, 0, 0);
      setFrozenUrl(
        canvas.toDataURL("image/jpeg", 0.9)
      );
    } catch (reason) {
      logError("[anime] 抓帧失败", reason);
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // 恢复上次保存的滚动位置（拖动重开转码导致的 effect 重建）
    const scroller = video.closest(
      ".dialog-scroll"
    ) as HTMLElement | null;
    if (
      scroller &&
      scrollTopRef.current !== null
    ) {
      scroller.scrollTop = scrollTopRef.current;
      scrollTopRef.current = null;
    }
    // 会话 id 用随机串：同一集重开也不会串到上一条转码进程
    const id = `anime-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    let stopped = false;
    let sourceBuffer: SourceBuffer | null = null;
    const queue: Uint8Array[] = [];
    /** queue 上限：后端 1.5× 转码，append 跟得上的话 queue 不会涨太多，
     *  这里兜底防内存爆炸（超过就丢最旧的，宁可丢数据也不卡死）。 */
    const MAX_QUEUE = 64;

    // 记住的音量在装流前落到 video（软解没有 loadedMetadata 时点）
    if (initialVolume !== undefined) {
      video.volume = initialVolume;
    }
    const mediaSource = new MediaSource();
    const objectUrl =
      URL.createObjectURL(mediaSource);
    video.src = objectUrl;

    /** 队列还有数据、且缓冲空闲时继续追加。 */
    const pump = () => {
      if (stopped || !sourceBuffer) return;
      if (
        sourceBuffer.updating ||
        queue.length === 0
      )
        return;
      try {
        sourceBuffer.appendBuffer(
          queue.shift() as BufferSource
        );
      } catch (reason) {
        logError("[anime] 追加分片失败", reason);
      }
    };

    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (stopped) return;
        try {
          sourceBuffer =
            mediaSource.addSourceBuffer(MIME);
        } catch (reason) {
          logError(
            "[anime] 不支持该 MSE 编码",
            reason
          );
          onError(
            "当前内核不支持软解播放（MSE 编码不支持）"
          );
          return;
        }
        sourceBuffer.addEventListener(
          "updateend",
          pump
        );
      }
    );

    // 新流真正渲染出画面（timeupdate 且 currentTime 在走）时撤冻结层。
    // 不能用 loadeddata：它在新流数据一可用就触发，会把刚设的冻结层立刻清掉。
    const clearFrozen = () => {
      if (
        frozenRef.current &&
        video.currentTime > 0
      ) {
        frozenRef.current = false;
        setFrozen(false);
      }
    };
    video.addEventListener(
      "timeupdate",
      clearFrozen
    );

    const unlisten: Array<() => void> = [];
    void listen<ChunkPayload>(
      CHUNK_EVENT,
      event => {
        if (stopped || event.payload.id !== id)
          return;
        // 第一块（含 moov）到达时给个占位时长，等真实时长回来再覆盖。
        if (
          event.payload.seq === 1 &&
          mediaSource.readyState === "open" &&
          !Number.isFinite(mediaSource.duration)
        ) {
          try {
            mediaSource.duration =
              Number.MAX_SAFE_INTEGER / 1000;
          } catch {
            // 已关闭则忽略
          }
        }
        if (queue.length >= MAX_QUEUE) {
          queue.shift();
        }
        queue.push(decode(event.payload.chunk));
        pump();
      }
    ).then(fn => unlisten.push(fn));

    void listen<EndPayload>(END_EVENT, event => {
      if (stopped || event.payload.id !== id)
        return;
      if (event.payload.error) {
        onError(
          `软解转码中断：${event.payload.error}`
        );
        return;
      }
      try {
        if (
          mediaSource.readyState === "open" &&
          (!sourceBuffer ||
            !sourceBuffer.updating)
        ) {
          mediaSource.endOfStream();
        }
      } catch {
        // 已经关闭就无所谓
      }
    }).then(fn => unlisten.push(fn));

    void invoke<{ duration: number }>(
      "anime_transcode_start",
      { id, url: src, start: startAt }
    )
      .then(result => {
        const dur = result?.duration ?? 0;
        if (dur <= 0) return;
        setTotal(dur);
        const apply = () => {
          if (stopped) return;
          if (mediaSource.readyState !== "open") {
            window.setTimeout(apply, 120);
            return;
          }
          try {
            mediaSource.duration = dur;
          } catch (reason) {
            logError(
              "[anime] 设置总时长失败",
              reason
            );
          }
        };
        apply();
      })
      .catch((reason: unknown) => {
        logError("[anime] 启动软解失败", reason);
        onError(String(reason));
      });

    // 播放进度 + 缓存区间：把相对时间映射成绝对区间
    const handleTimeUpdate = () => {
      setPos(startAt + video.currentTime);
      const ranges = video.buffered;
      const segs: Array<[number, number]> = [];
      for (let i = 0; i < ranges.length; i += 1) {
        segs.push([
          startAt + ranges.start(i),
          startAt + ranges.end(i)
        ]);
      }
      setBuffered(segs);
    };
    video.addEventListener(
      "timeupdate",
      handleTimeUpdate
    );
    video.addEventListener(
      "progress",
      handleTimeUpdate
    );
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);

    return () => {
      stopped = true;
      video.removeEventListener(
        "timeupdate",
        handleTimeUpdate
      );
      video.removeEventListener(
        "progress",
        handleTimeUpdate
      );
      video.removeEventListener(
        "timeupdate",
        clearFrozen
      );
      video.removeEventListener(
        "play",
        handlePlay
      );
      video.removeEventListener(
        "pause",
        handlePause
      );
      // 保存滚动位置，供下一次 effect 重建时恢复
      const currentScroller = video.closest(
        ".dialog-scroll"
      ) as HTMLElement | null;
      if (currentScroller) {
        scrollTopRef.current =
          currentScroller.scrollTop;
      }
      unlisten.forEach(fn => fn());
      void invoke("anime_transcode_stop", {
        id
      }).catch(() => {
        // 进程已退出时停不了，忽略
      });
      URL.revokeObjectURL(objectUrl);
    };
  }, [src, startAt, onError, initialVolume]);

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

  /** 用户 seek（绝对时间）：缓冲内直接跳，缓冲外重开转码。 */
  const onSeek = useCallback(
    (target: number) => {
      const video = videoRef.current;
      if (!video) return;
      // 立即把显示位置摆到目标，避免「松手后进度条弹回原位」等 timeupdate 才更新
      setPos(target);
      const ranges = video.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        const absStart =
          startAt + ranges.start(i);
        const absEnd = startAt + ranges.end(i);
        if (
          target >= absStart &&
          target <= absEnd
        ) {
          video.currentTime = target - startAt;
          return;
        }
      }
      // 重开转码：先抓一帧冻结，避免黑屏
      captureFrame();
      frozenRef.current = true;
      setFrozen(true);
      setStartAt(target);
    },
    [startAt, captureFrame]
  );

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void root.requestFullscreen();
    }
  }, []);

  /** 截图：抓当前帧存 PNG。 */
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
        a.download = `${title.replace(/[\\/:*?"<>|]/g, "_")}-${fmt(pos)}.png`;
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
  }, [t, title, pos]);

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
    onSkip: delta =>
      onSeek(
        Math.max(0, Math.min(total, pos + delta))
      ),
    onVolumeDelta: delta =>
      applyVolume(
        (videoRef.current?.volume ?? 1) + delta
      ),
    onToggleMute: toggleMute,
    onToggleFullscreen: toggleFullscreen
  });

  return (
    <div ref={rootRef} className="cin-root">
      <video
        ref={videoRef}
        className="cin-video"
        autoPlay
        playsInline
        onClick={togglePlay}
        onError={() =>
          onError(
            "软解播放失败（ffmpeg 未就绪或片源不可达）"
          )
        }
      />
      {frozen && (
        <div className="cin-frozen">
          {frozenUrl && (
            <img
              className="cin-frame"
              src={frozenUrl}
              alt=""
            />
          )}
          <div className="cin-spin" />
        </div>
      )}
      <CinemaControls
        rootRef={rootRef}
        state={{
          title,
          playing,
          current: pos,
          duration: total,
          buffered,
          volume,
          muted,
          rate,
          loopOn,
          switching: switching ?? false
        }}
        actions={{
          onTogglePlay: togglePlay,
          onSeek,
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
