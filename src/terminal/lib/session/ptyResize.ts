/**
 * PTY 尺寸同步：本地 fit 与「把尺寸告诉后端 PTY」之间的防抖、暂停与
 * 恢复机制。
 *
 * 从 useTerminals.ts 拆出。核心矛盾（本项目连续踩坑三次，见各注释）：
 * 把行列数同步给 PTY 会触发「ConPTY 整屏重发视口 + 远端 readline 重绘
 * + xterm reflow」三方叠加，屏幕显示内容被挤掉；而**不**同步又会让
 * 远端按旧列数排版。因此按场景区分：
 * - 真实 resize（拖分隔条、窗口缩放）：正常同步；
 * - 本地宽度突变（AI 面板开合、拆分、折叠）：只本地 fit，挂起同步；
 * - 字号变化：挂起后必须补一次同步（字符尺寸变了远端要重排）。
 */
import {
  useCallback,
  useEffect,
  useRef
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenSession } from "./terminalTypes";
import type { PaneState } from "./paneGrid";

/**
 * PTY 尺寸同步的防抖时长（毫秒）：尺寸连续变化期间只在停下来之后通知一次。
 *
 * 取值要盖过一次「连续滚轮缩放」或「拖拽窗口」的节奏（手速快时相邻两次
 * 变化间隔约 150~300ms），否则每一次变化都会让 ConPTY 重绘一遍、远端
 * shell 重画一遍提示符，屏幕很快就花了。
 */
const PTY_RESIZE_DEBOUNCE = 400;

/** 连续多少帧尺寸不变才算「稳定」，见 waitForStableSize。 */
const STABLE_FRAMES = 3;

/**
 * 等终端容器尺寸稳定再让 PTY 出生。
 *
 * ConPTY 在尺寸变化时会整屏重绘，重绘很容易把屏幕弄乱（重复提示符、
 * 丢历史）。连接那一瞬间容器高度往往还在变（字体加载、欢迎卡片、AI 面板
 * 与侧栏渲染），只 rAF 两帧等不住 —— PTY 于是「生错了尺寸」，紧接着的
 * 第一次 resize 就触发重绘。这里等「连续几帧尺寸不变」，最多等 600ms。
 */
export function waitForStableSize(
  element: HTMLElement,
  timeout = 600
): Promise<void> {
  return new Promise(resolve => {
    const started = performance.now();
    let previous = "";
    let stableFrames = 0;
    const check = () => {
      const size = `${element.clientWidth}x${element.clientHeight}`;
      if (size === previous) stableFrames += 1;
      else {
        previous = size;
        stableFrames = 0;
      }
      if (
        stableFrames >= STABLE_FRAMES ||
        performance.now() - started > timeout
      ) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/** usePtyResizeSync 依赖的三个 ref：都在 useTerminals 里创建，此处只读。 */
export interface PtyResizeSyncRefs {
  openedRef: React.RefObject<OpenSession[]>;
  disconnectedRef: React.RefObject<
    Record<string, boolean>
  >;
  panesRef: React.RefObject<PaneState[]>;
}

/**
 * PTY 尺寸同步机制。
 *
 * 返回的 resize / pausePtySync / setPtyResizePaused 由 useTerminals
 * 透传给 UI（AI 面板开合、系统信息抽屉、字号变化等场景调用）；
 * ptyResizeTimers 暴露给卸载清理用。
 */
export function usePtyResizeSync(
  refs: PtyResizeSyncRefs
) {
  const { openedRef, disconnectedRef, panesRef } =
    refs;
  /** PTY 行高同步暂停标记（系统信息抽屉打开时为真） */
  const ptyPausedRef = useRef(false);
  /** 待发送的 PTY 尺寸（按会话 id），见 schedulePtyResize 的说明 */
  const ptyResizeTimers = useRef(
    new Map<
      string,
      ReturnType<typeof setTimeout>
    >()
  );
  /** 已经同步给 PTY 的尺寸（按会话 id）：只有真的变了才再打扰一次 PTY */
  const syncedSizes = useRef(
    new Map<string, string>()
  );
  /**
   * 把尺寸变化延后到稳定后再通知 PTY。
   *
   * 拖窗口、面板动画、Ctrl+滚轮缩放字号都会在几百毫秒内产生**十几次**
   * 尺寸变化。每变一次就发一次 terminal_resize，远端 shell 就要重绘一次
   * 提示符 —— ConPTY 重绘与远端 readline 一错位，旧提示符擦不干净，
   * 屏幕上就堆出一串重复的 `user@host:~#`。本地 fit 照旧每帧执行
   * （显示始终正确），只是把「稳定后」的最终尺寸发过去。
   */
  const schedulePtyResize = useCallback(
    (session: OpenSession) => {
      const pending = ptyResizeTimers.current.get(
        session.id
      );
      if (pending) clearTimeout(pending);
      ptyResizeTimers.current.set(
        session.id,
        setTimeout(() => {
          ptyResizeTimers.current.delete(
            session.id
          );
          // 期间可能已经断开或被关闭：再发 resize 只会收到错误
          if (
            disconnectedRef.current[session.id] ||
            !openedRef.current.includes(session)
          ) {
            return;
          }
          // 记一下缓冲长度：resize 前后若它变短，说明 ConPTY 重发把
          // 内容挤掉了（用户报「开合 AI 面板后内容变少」）
          const before =
            session.terminal.buffer.active.length;
          const sizeKey = `${session.terminal.rows}x${session.terminal.cols}`;
          if (
            syncedSizes.current.get(
              session.id
            ) === sizeKey
          )
            return;
          syncedSizes.current.set(
            session.id,
            sizeKey
          );
          console.debug(
            `[terminal] 同步 PTY 尺寸 ${session.id} ${sizeKey}`
          );
          invoke("terminal_resize", {
            id: session.id,
            rows: session.terminal.rows,
            cols: session.terminal.cols
          })
            .then(() => {
              // 这里**不要**再发 Ctrl+L 清屏重画：输出重复的根因是孤儿
              // 监听器（已修复），resize 本身的 ConPTY 重绘内容是完整的，
              // 每次都清屏反而把用户正在看的屏幕抹掉
              const after =
                session.terminal.buffer.active
                  .length;
              console.debug(
                `[terminal] resize 后缓冲 ${before} → ${after} 行` +
                  (after < before
                    ? ` ⚠️ 少了 ${before - after} 行`
                    : "")
              );
            })
            .catch(reason => {
              // PTY 还没建立（start 未完成）时会走到这里。以前静默吞掉，
              // 同步就此丢失、PTY 与本地尺寸永久脱节 —— 至少留个痕
              console.debug(
                `[terminal] PTY 尺寸同步被拒 ${session.id}`,
                reason
              );
            });
        }, PTY_RESIZE_DEBOUNCE)
      );
    },
    [disconnectedRef, openedRef]
  );
  /** 取消某个会话待发送的尺寸同步（关闭标签时调用）。 */
  const cancelPtyResize = useCallback(
    (id: string) => {
      const pending =
        ptyResizeTimers.current.get(id);
      if (pending) clearTimeout(pending);
      ptyResizeTimers.current.delete(id);
      syncedSizes.current.delete(id);
    },
    []
  );
  const resize = useCallback(
    (current?: OpenSession) => {
      // 显式指定就只动它；否则**所有窗格**各跟一次 —— ResizeObserver
      // 拖分隔条 / 窗口缩放都会触发，只 fit 一个窗格会把其余的留在旧尺寸。
      // 已断开的会话不再向后端 resize：PTY 可能已被移除，
      // 调用只会产生"终端会话不存在"的错误气泡
      const targets = current
        ? [current]
        : panesRef.current
            .map(pane =>
              openedRef.current.find(
                s => s.id === pane.visibleId
              )
            )
            .filter(
              (session): session is OpenSession =>
                Boolean(session)
            );
      for (const session of targets) {
        if (
          session &&
          !disconnectedRef.current[session.id]
        ) {
          if (
            document.body.classList.contains(
              "terminal-focus"
            )
          ) {
            // 专注模式只扩高本地视口，列数和 PTY 尺寸保持原样；
            // 否则退出宽屏时 ls 等按列排版的历史输出会被重新折行。
            const dimensions =
              session.fit.proposeDimensions();
            if (dimensions)
              session.terminal.resize(
                session.terminal.cols,
                dimensions.rows
              );
            session.terminal.scrollToBottom();
            continue;
          }
          session.fit.fit();
          session.terminal.scrollToBottom();
          console.debug(
            `[terminal] fit ${session.id} → ${session.terminal.cols}x${session.terminal.rows}` +
              ` 缓冲 ${session.terminal.buffer.active.length} 行` +
              ` 视口 ${session.terminal.buffer.active.viewportY}/${session.terminal.buffer.active.baseY}` +
              ` 暂停=${ptyPausedRef.current ? "pty" : ""}${zoomSyncPausedRef.current ? "zoom" : ""}`
          );
          // 抽屉打开期间暂停向 PTY 同步行高：ConPTY 收缩会丢掉屏幕
          // 上方内容，恢复时整屏重绘把历史打回空白；只缩本地视口即可，
          // 远端布局保持不变（见 setPtyResizePaused）
          if (ptyPausedRef.current) continue;
          // Ctrl+滚轮缩放期间所有会话都挂起 PTY 同步（见 pausePtySync）：
          // SSH 会话里 ssh.exe 同样跑在 ConPTY 中，resize 会触发
          // 「ConPTY 整屏重绘 + 远端 readline 重绘 + xterm reflow」三方
          // 叠加，屏幕只剩一个提示符
          if (zoomSyncPausedRef.current) continue;
          // 尺寸连续变化时合并，只在稳定后同步一次（见 schedulePtyResize）
          schedulePtyResize(session);
        }
      }
    },
    [
      disconnectedRef,
      openedRef,
      panesRef,
      schedulePtyResize
    ]
  );

  // resize 的 ref 镜像：给同步回调（pausePtySync 的收尾、ResizeObserver）
  // 取最新值，避免把 resize 塞进它们的依赖数组导致定时器反复重置
  const resizeRef = useRef(resize);
  useEffect(() => {
    resizeRef.current = resize;
  }, [resize]);

  /**
   * 暂停/恢复向 PTY 同步行高（系统信息抽屉开合时调用）。
   *
   * 抽屉收缩终端时若把 PTY 一起缩到十几行，ConPTY 会丢掉屏幕上方内容，
   * 恢复时整屏重绘只剩那十几行（表现为「先恢复、一闪又缩回去」）。
   * 暂停后 ResizeObserver 只缩本地视口；恢复时补一次 resize，
   * 把完整尺寸同步回远端。
   */
  const setPtyResizePaused = useCallback(
    (paused: boolean) => {
      ptyPausedRef.current = paused;
      if (!paused) resize();
    },
    [resize]
  );

  /** Ctrl+滚轮缩放 / 面板开合期间挂起 PTY 尺寸同步的标记与收尾定时器 */
  const zoomSyncPausedRef = useRef(false);
  const zoomSettleTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  /**
   * 挂起**所有会话**的 PTY 尺寸同步，`settleMs` 毫秒后解除。
   *
   * 为什么要挂起：尺寸变化一旦同步给 PTY，就会触发三方重绘叠加 ——
   * 本地 ConPTY 整屏重发视口（`\x1b[H` + 逐行覆盖）、SSH 会话里 ssh.exe
   * 同样跑在 ConPTY 中加上远端 readline 重绘、xterm 自身再做一次 reflow。
   * 三者互相错位，**屏幕内容被整屏重发挤掉**（实测：探针抓 ConPTY 序列 +
   * stub 回放；用户报「开合 AI 助手后内容变少」，且丢的是**中段**）。
   *
   * 因此这类「用户没在拖窗口、只是面板开合」引发的尺寸变化
   * **一律不同步给任何 PTY**：本地 fit 照常执行（显示正确、缓冲不丢）。
   *
   * ⚠️ **`flush` 一律传 false**（本项目已连续踩坑两次）：
   * 「等一会儿补一次同步」看着自然，但那次补同步本身就是丢内容的动作 ——
   * 面板开合场景下远端根本不需要知道新列数（本地 fit 已让显示正确），
   * 补同步只会白白招来一轮 ConPTY 重绘。真正需要 flush 的是字号变化：
   * 字符尺寸变了以后远端必须按新列数排版，否则换行全错。
   */
  const pausePtySync = useCallback(
    (settleMs = 600, flush = false) => {
      // ⚠️ **必须连已排队的 timer 一起杀掉**（此前漏掉，导致折叠仍丢内容）：
      //挂起只让 `resize()` 里的 `continue` 生效 = 挡住「之后新发的同步」，
      // 但挂起之前 resize 已经调过 `schedulePtyResize`，那个 400ms 防抖
      // timer 还在 `ptyResizeTimers` 里，到点照样发 `terminal_resize`。
      // 而且防抖 400ms 与 settleMs 几乎相等，正好错开挂起窗口 → 同步漏网。
      for (const timer of ptyResizeTimers.current.values())
        clearTimeout(timer);
      ptyResizeTimers.current.clear();
      // 定时器句柄是可变状态，规则按不可变数据对待属于误报，显式放行
      /* eslint-disable react-hooks/immutability */
      zoomSyncPausedRef.current = true;
      if (zoomSettleTimer.current)
        clearTimeout(zoomSettleTimer.current);
      zoomSettleTimer.current = setTimeout(() => {
        zoomSettleTimer.current = null;
        zoomSyncPausedRef.current = false;
        if (flush) resizeRef.current();
      }, settleMs);
      /* eslint-enable react-hooks/immutability */
    },
    []
  );

  return {
    resize,
    resizeRef,
    schedulePtyResize,
    cancelPtyResize,
    pausePtySync,
    setPtyResizePaused,
    ptyResizeTimers,
    // 已同步尺寸表：startSession 建连后要把自己写进去（标记为「无需再同步」），
    // 否则 resize 会补发一次初始尺寸、白白触发一次 ConPTY 重绘
    syncedSizes
  };
}
