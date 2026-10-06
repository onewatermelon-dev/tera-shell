import { clampFontSize } from "@/settings/lib/settings";

/**
 * 一档缩放需要的滚轮位移（像素）。
 *
 * 鼠标滚轮一格约 100，即滚一下就一档；触控板的小步连续事件会累积到
 * 阈值才走一档 —— 否则一次手势就能把字号从头拽到尾。
 */
const WHEEL_STEP = 40;

/** 浮层提示的停留时长（毫秒）。 */
const HINT_DURATION = 1200;

type FontZoomOptions = {
  /** 终端宿主元素：滚轮监听从它收，提示浮层挂在它下面 */
  host: HTMLElement;
  /** 读当前字号（从终端实例取，避免闭包读到过期的设置值） */
  getFontSize: () => number;
  /** 应用新字号：由调用方写回设置，再同步给所有终端 */
  applyFontSize: (fontSize: number) => void;
  /** 生成浮层文案，如「字号 16 px」 */
  formatHint: (fontSize: number) => string;
};

/**
 * 给终端宿主挂上 Ctrl + 滚轮缩放字号。
 *
 * 监听在**捕获阶段**：xterm 自己会处理滚轮做回滚，必须抢在它前面
 * preventDefault + stopPropagation，否则缩放的同时终端还在滚屏。
 *
 * 这里只负责「手势 → 新字号」这一层，生效与持久化交给调用方
 * （useTerminals 写回设置，外观 effect 再统一推给所有终端）。
 *
 * 返回清理函数：解绑监听并移掉提示浮层。
 */
export function attachFontZoom({
  host,
  getFontSize,
  applyFontSize,
  formatHint
}: FontZoomOptions): () => void {
  /** 累计的滚轮位移，够一档就清零 */
  let accumulated = 0;
  let hint: HTMLDivElement | null = null;
  let hintTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  /** 在终端右下角闪一下当前字号；没有 DOM 时静默跳过（单测环境）。 */
  function showHint(fontSize: number) {
    const doc = host.ownerDocument;
    if (!doc) return;
    if (!hint) {
      hint = doc.createElement("div");
      hint.className = "terminal-zoom-hint";
      host.append(hint);
    }
    hint.textContent = formatHint(fontSize);
    hint.classList.add("is-visible");
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hintTimer = null;
      hint?.classList.remove("is-visible");
    }, HINT_DURATION);
  }

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    // 抢在 xterm 的滚动处理之前：缩放时终端不能再跟着滚屏
    event.preventDefault();
    event.stopPropagation();
    // deltaMode=1 是「按行」的环境，换算成像素，否则一次滚轮不足一档
    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaY;
    accumulated += delta;
    if (Math.abs(accumulated) < WHEEL_STEP)
      return;
    // 上滚放大、下滚缩小
    const direction = accumulated < 0 ? 1 : -1;
    accumulated = 0;
    const current = getFontSize();
    const next = clampFontSize(
      current + direction
    );
    console.debug(
      "[terminal] Ctrl+滚轮缩放字号",
      {
        current,
        next
      }
    );
    // 已到上下限时不再写设置（避免无谓落盘），但仍然给提示，
    // 否则用户会以为滚轮失灵
    if (next !== current) applyFontSize(next);
    showHint(next);
  };

  host.addEventListener("wheel", onWheel, {
    passive: false,
    capture: true
  });

  return () => {
    host.removeEventListener("wheel", onWheel, {
      capture: true
    });
    if (hintTimer) clearTimeout(hintTimer);
    hint?.remove();
  };
}
