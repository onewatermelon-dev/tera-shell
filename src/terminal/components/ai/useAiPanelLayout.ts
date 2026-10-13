/**
 * AI 面板的布局状态：可拖宽度、收起浮窗、收起按钮的垂直位置。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。三件事都只围绕
 * 「右侧 AI 面板怎么摆」：宽度拖拽（落 ai_prefs.json）、收起/展开，
 * 以及收起后浮窗按钮的上下拖动（位置同样持久化）。
 *
 * 开合面板会同步触发一次「挂起 PTY 同步 + 补全量 fit」（见下），
 * 所以 hook 接收那两个回调，不自己碰终端。
 */
import {
  useEffect,
  useRef,
  useState
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  loadPanelWidth,
  loadReopenTabTop,
  savePanelWidth,
  saveReopenTabTop
} from "@/terminal/lib/ai/aiPrefs";

/**
 * 收起后浮窗按钮的高度（px）。与 `.ai-reopen-tab` 的 height 一致 ——
 * 窗口变矮后要把存下来的 top 钳回可视区，得知道按钮有多高。
 * 兜底值和 CSS 保持同步，改 CSS 时这里也要改。
 */
const REOPEN_TAB_HEIGHT = 72;

export function useAiPanelLayout(
  onResize: () => void,
  onPausePtySync: () => void
) {
  const [aiWidth, setAiWidth] = useState<number>(
    () => {
      // 最小宽度 390：旧存档里更小的值一并抬回来
      return Math.max(
        390,
        loadPanelWidth() ?? 390
      );
    }
  );
  // AI 面板收起状态：收起后贴窗口右缘成浮窗按钮
  const [aiCollapsed, setAiCollapsed] =
    useState(false);

  /**
   * AI 面板开合：先挂起 PTY 同步、再补一次全量 fit。
   *
   * 两个动作缺一不可：
   *
   * 1. **挂起 PTY 同步**（`onPausePtySync`）：面板开合只是本地容器宽度变了，
   *    没必要惊动 ConPTY。一旦把新列数同步过去，会触发
   *    「ConPTY 整屏重发视口 + 远端 readline 重绘 + xterm reflow」三方叠加，
   *    屏幕内容被整屏重发挤掉 —— 表现为「开合 AI 助手后内容变少」（丢中段）。
   *    挂起期间只做本地 fit：显示立刻正确，缓冲不丢。
   *    ⚠️ 挂起**不补同步**（flush=false）：那次补同步本身就是丢内容的动作，
   *    而远端不需要知道新列数（本地 fit 已让显示正确）。
   *
   * 2. **等两帧再 fit**：rAF 保证 DOM 已更新，第二帧保证 grid 布局落定。
   *    面板收起时 `has-panel` 类被摘掉、面板整体卸载，列定义重排有中间态；
   *    只靠 ResizeObserver 常会命中中间态，按过期宽度算出列数。
   */
  useEffect(() => {
    onPausePtySync();
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        onResize();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [
    aiCollapsed,
    aiWidth,
    onResize,
    onPausePtySync
  ]);

  const aiHostRef = useRef<HTMLDivElement>(null);
  /** 拖拽开始时钉住容器矩形，避免拖动过程中重读布局 */
  const aiDragRef = useRef<DOMRect | null>(null);

  function startAiResize(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    const host = aiHostRef.current;
    if (!host) return;
    event.currentTarget.setPointerCapture(
      event.pointerId
    );
    aiDragRef.current =
      host.getBoundingClientRect();
  }

  function moveAiResize(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    const rect = aiDragRef.current;
    if (!rect) return;
    const min = 390;
    // 上限 = 容器一半（再减去分隔条 5px 与两条 4px 间隙）
    const max = (rect.width - 13) / 2;
    const next = Math.min(
      Math.max(min, rect.right - event.clientX),
      Math.max(min, max)
    );
    setAiWidth(Math.round(next));
  }

  function endAiResize() {
    aiDragRef.current = null;
    savePanelWidth(aiWidth);
  }

  /**
   * 收起后的浮窗按钮：默认贴右缘垂直居中，可**上下拖动**改位置，
   * 位置跟着 `ai_prefs.json` 走（下次启动还在原处）。
   *
   * `reopenTop` 为 null 表示「不指定，交给 CSS 居中」—— 用 null 而不是
   * 一个算出来的数字，是为了让「首次运行」和「窗口缩放后」都保持居中：
   * 存死像素值的话，窗口一变高按钮就偏在旧位置上了。
   */
  const [reopenTop, setReopenTop] = useState<
    number | null
  >(() => loadReopenTabTop());
  /** 拖拽中：钉住「指针相对按钮顶边」的偏移 + 起手时的 clientY */
  const reopenDragRef = useRef<{
    grabOffset: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  /**
   * 本次手势是否拖过（松手后仍要留着，供 click 判断）。
   * 单独一个 ref 而不是读reopenDragRef —— 后者在 endReopenDrag
   * 里就被清空了，click 拿到的是 null，拖过也会误判成「点击」。
   */
  const reopenDraggedRef = useRef(false);
  /**
   * 与 state 同步的镜像（写入与 setState 同一处）。用于松手时落盘：
   * pointerup 那一刻 state 可能还没提交，读它会拿到上一帧的值。
   * ⚠️ 渲染期不能写 ref —— 只在 move/起手这些事件回调里写。
   */
  const reopenTopRef = useRef(reopenTop);

  function startReopenDrag(
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    // 指针不在按钮内也要能起手（比如从按钮上方按下再往下拖）
    const rect =
      event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(
      event.pointerId
    );
    reopenDragRef.current = {
      grabOffset: event.clientY - rect.top,
      startY: event.clientY,
      moved: false
    };
  }

  function moveReopenDrag(
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    const drag = reopenDragRef.current;
    if (!drag) return;
    if (
      !drag.moved &&
      Math.abs(event.clientY - drag.startY) < 3
    )
      // 3px 内当点击处理，否则松手会既展开面板又改位置
      return;
    drag.moved = true;
    reopenDraggedRef.current = true;
    // 全局挂抓取光标（悬浮在按钮外的那些像素也要变）
    document.body.classList.add(
      "reopen-dragging"
    );
    const height =
      event.currentTarget.offsetHeight ||
      REOPEN_TAB_HEIGHT;
    // 钳在窗口内：上下都留边，别拖到屏幕外找不回来
    const max = Math.max(
      0,
      window.innerHeight - height
    );
    const next = Math.min(
      max,
      Math.max(0, event.clientY - drag.grabOffset)
    );
    // ref 与 setState 同步更新：松手时要从 ref 读最新值
    reopenTopRef.current = next;
    setReopenTop(next);
  }

  /**
   * 窗口变矮后，存下来的旧位置可能已经跑到屏幕外（按钮找不回来）。
   * 监听 resize 把位置钳回可视区，但不落盘 —— 那是拖动时给的基准，
   * 下次窗口又变高时用户期望它还在原来的相对位置。
   */
  useEffect(() => {
    const clamp = () => {
      const current = reopenTopRef.current;
      if (current === null) return;
      const max = Math.max(
        0,
        window.innerHeight - REOPEN_TAB_HEIGHT
      );
      if (current > max) {
        reopenTopRef.current = max;
        setReopenTop(max);
      }
    };
    window.addEventListener("resize", clamp);
    return () =>
      window.removeEventListener("resize", clamp);
  }, []);

  function endReopenDrag(
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    reopenDragRef.current = null;
    document.body.classList.remove(
      "reopen-dragging"
    );
    // 落盘拖完的位置。⚠️ 从同步的ref 读，**不要写进 setState 的
    // updater 里落盘**（updater 是副作用重灾区：StrictMode 下跑两次、
    // 且返回值必须是纯的）；ref 在每次 move 里就更新好了，比 state 新
    saveReopenTabTop(reopenTopRef.current);
    // 拖过就不当点击 —— 否则松手会顺带把面板拉回来
    if (reopenDraggedRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return {
    aiHostRef,
    aiWidth,
    aiCollapsed,
    setAiCollapsed,
    reopenTop,
    startAiResize,
    moveAiResize,
    endAiResize,
    startReopenDrag,
    moveReopenDrag,
    endReopenDrag,
    reopenDraggedRef
  };
}
