import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn
} from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/sessions/lib/session";
import { registerTerminalLinks } from "@/terminal/lib/terminalLinks";
import { explainCommand } from "@/terminal/lib/aiExplain";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import {
  highlightToAnsi,
  isVimCommand,
  parseCatCommand,
  VIM_SCHEME_SETUP
} from "@/terminal/lib/catView";
import { renderTextOnlySelection } from "@/terminal/lib/terminalSelection";
import { stripPrompt } from "@/terminal/lib/stripPrompt";
import { attachCommandCompletion } from "@/terminal/lib/commandCompletion";
import { createTerminalMenu } from "@/terminal/lib/terminalContextMenu";
import { attachFontZoom } from "@/terminal/lib/fontZoom";
import { useTerminalSearch } from "@/terminal/lib/useTerminalSearch";
import { useTerminalReconnect } from "@/terminal/lib/useTerminalReconnect";
import {
  DEFAULT_FONT_SIZE,
  resolveFontFamily,
  type AppSettings
} from "@/settings/lib/settings";
import { useT } from "@/settings/lib/i18n";
import {
  resolveColorScheme,
  toXtermTheme
} from "@/terminal/lib/colorSchemes";
import type { OpenSession } from "@/terminal/lib/terminalTypes";
import {
  collectLeafIds,
  createLeaf,
  hasLeaf,
  removePane,
  setSplitRatio,
  splitPane,
  type PaneNode,
  type SplitDirection
} from "@/terminal/lib/paneLayout";

// 会话类型定义在 terminalTypes，这里重新导出，外部仍从 useTerminals 引入
export type { OpenSession } from "@/terminal/lib/terminalTypes";

/**
 * 一个窗格：它自己的一组标签 + 当前显示哪一个。
 *
 * 每个标签是一只**独立会话**（独立 PTY），窗格只负责决定「这一格里
 * 摆哪些标签、现在亮哪一只」。
 */
export type PaneState = {
  /** 与布局树里的叶子 paneId 对应 */
  id: string;
  /** 本窗格的标签（会话 id，按加入顺序） */
  tabIds: string[];
  /** 当前显示在这个窗格里的会话 id；空串表示本窗格没有标签 */
  visibleId: string;
};

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
function waitForStableSize(
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

export function useTerminals(
  onError: (reason: unknown) => void,
  onSavePassword:
    | ((
        sourceSessionId: string,
        encrypted: string
      ) => void)
    | undefined,
  /**
   * 终端外观与行为设置：字体、字号与配色随之变化，整批终端一起更新；
   * 命令补全开关同样实时同步（新建会话取初值，已有会话由 effect 推送）；
   * 回滚行数也在这里，改动会立刻调整已打开终端的滚动缓冲区。
   */
  appearance: Pick<
    AppSettings,
    | "fontFamily"
    | "fontSize"
    | "colorScheme"
    | "commandCompletion"
    | "cursorStyle"
    | "cursorBlink"
    | "scrollback"
  >,
  /**
   * Ctrl + 滚轮缩放字号后的落地：把新字号写回设置。
   *
   * 写回设置是「带记忆」的关键 —— 字号存在设置文件里，重启后照旧；
   * 同时外观 effect 会把新字号推给所有已打开的终端。
   */
  onFontSizeChange: (fontSize: number) => void
) {
  const t = useT();
  const [opened, setOpened] = useState<
    OpenSession[]
  >([]);
  const [disconnected, setDisconnected] =
    useState<Record<string, boolean>>({});
  const [passwordRequest, setPasswordRequest] =
    useState<{
      session: SavedSession;
      sourceSessionId: string;
    } | null>(null);
  const openedRef = useRef(opened);
  /**
   * 当前会话 id：= **活动窗格正在显示的那只**。
   *
   * 搜索、快捷宏、AI 面板、状态栏都以它为"用户正对着的那只会话"，
   * 因此它必须跟着活动窗格走 —— 焦点在右格时，搜索要搜的是右格那只。
   * 用 ref 暴露给 useTerminalSearch / 输出监听等命令式代码。
   */
  const activeIdRef = useRef("");
  const disconnectedRef = useRef(disconnected);
  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);
  useEffect(() => {
    disconnectedRef.current = disconnected;
  }, [disconnected]);

  // 断线自动重连：SSH 会话被 ssh 以 255 结束（网络断开、远端重启）时
  // 退避重试若干次，失败后由右键菜单手动接管（见 useTerminalReconnect）
  const {
    handleDisconnect,
    reconnect: reconnectSession,
    cancelReconnect,
    cancelAllReconnects
  } = useTerminalReconnect({
    openedRef,
    disconnectedRef,
    setDisconnected,
    cursorBlink: appearance.cursorBlink,
    onError
  });

  // 查找能力（搜索框开关、高亮与结果计数），内部自带状态
  const search = useTerminalSearch(
    openedRef,
    activeIdRef
  );

  const unlisteners = useRef<UnlistenFn[]>([]);
  const resizeObserver = useRef<
    ResizeObserver | undefined
  >(undefined);
  const documentShortcutHandler = useRef<
    ((event: KeyboardEvent) => void) | undefined
  >(undefined);
  // 终端右键菜单（命令式 DOM，逻辑见 terminalContextMenu）：
  // 首次用到时才创建，那时 openSearch 已经定义好。
  // 菜单只建一次，重连入口经 ref 转发，避免闭包锁死旧设置
  const terminalMenu = useRef<ReturnType<
    typeof createTerminalMenu
  > | null>(null);
  const reconnectRef = useRef(reconnectSession);
  useEffect(() => {
    reconnectRef.current = reconnectSession;
  }, [reconnectSession]);

  // ---- 窗格（多标签组网格） ----
  // panes 与 tree 分开存：
  // - panes：每个窗格有哪些标签、当前显示哪一个（**可变状态**）
  // - tree ：窗格怎么排（**布局**，纯数据，见 paneLayout.ts）
  // 分开是因为「关掉一个标签」只动 panes，「折叠一个窗格」才动 tree，
  // 两者互不牵连，React 比较时也能各自短路。
  //
  // 拆分 = 用被拆会话的配置新起一个独立会话（独立 PTY，VSCode 式），
  // 不是同一 PTY 的镜像 —— 单 PTY 喂两个不同宽度的视图必然互相重排
  // （拖分隔线时提示行被重复推下去），独立 PTY 各管各的尺寸就没有这类
  // 问题。拖标签进别的窗格也能加标签；关掉标签就是关掉该会话。
  const FIRST_PANE_ID = "pane-1";
  const [panes, setPanesState] = useState<
    PaneState[]
  >([
    {
      id: FIRST_PANE_ID,
      tabIds: [],
      visibleId: ""
    }
  ]);
  const [tree, setTreeState] = useState<PaneNode>(
    createLeaf(FIRST_PANE_ID)
  );
  // 活动窗格：键盘焦点、选中胶囊、宏执行目标都跟着它走
  const [activePaneId, setActivePaneId] =
    useState(FIRST_PANE_ID);
  // 闭包里读活动窗格（close 折叠窗格时判断活动权要不要移交）
  const activePaneIdRef = useRef(activePaneId);
  useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  // ref 供闭包读最新值（split/close/输出监听里判断）
  const panesRef = useRef(panes);
  const setPanes = useCallback(
    (
      updater:
        | PaneState[]
        | ((prev: PaneState[]) => PaneState[])
    ) => {
      const next =
        typeof updater === "function"
          ? updater(panesRef.current)
          : updater;
      panesRef.current = next;
      setPanesState(next);
    },
    []
  );
  const treeRef = useRef(tree);
  const setTree = useCallback(
    (
      updater:
        PaneNode | ((prev: PaneNode) => PaneNode)
    ) => {
      const next =
        typeof updater === "function"
          ? updater(treeRef.current)
          : updater;
      treeRef.current = next;
      setTreeState(next);
    },
    []
  );

  /**
   * 改布局树，并同步维护 panes 里的窗格记录。
   *
   * 两侧必须一起动，否则会留下幽灵：树里新增的 paneId 若没有对应记录，
   * 标签条渲染不出来；被摘掉的窗格若记录还在，就有个永远不显示、
   * 也永远关不掉的空标签组。
   */
  const setTreeAndSync = useCallback(
    (updater: (prev: PaneNode) => PaneNode) => {
      setTree(prev => {
        const next = updater(prev);
        const ids = new Set(collectLeafIds(next));
        const kept = panesRef.current.filter(
          pane => ids.has(pane.id)
        );
        const nextPanes = [...kept];
        for (const id of ids) {
          if (
            !nextPanes.some(
              pane => pane.id === id
            )
          ) {
            nextPanes.push({
              id,
              tabIds: [],
              visibleId: ""
            });
          }
        }
        setPanes(nextPanes);
        return next;
      });
    },
    [setPanes, setTree]
  );

  /** 活动窗格（组被整体关掉时自动回落到第一个）。 */
  const activePane =
    panes.find(
      pane => pane.id === activePaneId
    ) ?? panes[0];
  const activePaneRef = useRef(activePane);
  useEffect(() => {
    activePaneRef.current = activePane;
  }, [activePane]);
  // 当前会话 = 活动窗格显示的那只。派生而非独立 state —— 两个真值
  // 来源迟早会打架（切了窗格但 activeId 还指着旧会话）。
  const activeId = activePane?.visibleId ?? "";
  const active = opened.find(
    s => s.id === activeId
  );
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /**
   * 窗格宿主：paneId → 元素。终端元素是命令式 replaceChildren 挂进去的，
   * React 不感知，所以宿主必须由调用方注册进来。
   */
  const paneHostRefs = useRef(
    new Map<string, HTMLElement>()
  );
  const setPaneHost = useCallback(
    (paneId: string, el: HTMLElement | null) => {
      if (el)
        paneHostRefs.current.set(paneId, el);
      else paneHostRefs.current.delete(paneId);
    },
    []
  );

  const searchResult = search.results[
    activeId
  ] ?? {
    index: -1,
    count: 0
  };

  // ---- 1. Tab management ----
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
    []
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
          // 抽屉打开期间暂停向 PTY 同步行高：ConPTY 收缩会丢掉屏幕
          // 上方内容，恢复时整屏重绘把历史打回空白；只缩本地视口即可，
          // 远端布局保持不变（见 setPtyResizePaused）
          if (ptyPausedRef.current) continue;
          // Ctrl+滚轮缩放期间所有会话都挂起 PTY 同步（见 pausePtyForZoom）：
          // SSH 会话里 ssh.exe 同样跑在 ConPTY 中，resize 会触发
          // 「ConPTY 整屏重绘 + 远端 readline 重绘 + xterm reflow」三方
          // 叠加，屏幕只剩一个提示符
          if (zoomSyncPausedRef.current) continue;
          // 尺寸连续变化时合并，只在稳定后同步一次（见 schedulePtyResize）
          schedulePtyResize(session);
        }
      }
    },
    [schedulePtyResize]
  );

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

  /** Ctrl+滚轮缩放期间挂起 PTY 尺寸同步的标记与手势收尾定时器 */
  const zoomSyncPausedRef = useRef(false);
  const zoomSettleTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  /**
   * 缩放手势开始：挂起**所有会话**的 PTY 尺寸同步，滚轮停止 600ms 后解除。
   *
   * 每档字号都会改列数，而每次 resize 都会触发一轮三方重绘叠加：
   * 本地 ConPTY 整屏重发视口（`\x1b[H` + 逐行覆盖）、SSH 会话里
   * ssh.exe 同样跑在 ConPTY 中加上远端 readline 重绘、xterm 自身再做
   * 一次 reflow —— 三者互相错位，屏幕上只剩一个提示符（实测：探针抓
   * ConPTY 序列 + stub 回放）。因此缩放引发的尺寸变化**不同步给任何
   * PTY**：本地 fit 照常执行（显示正确、缓冲不丢），各 PTY 保持原宽度，
   * 直到下一次真实的容器 resize（拖窗口/开关面板）再重新对齐。
   * ponytail: 600ms 挂起窗口内恰好拖动窗口的话，那一次尺寸变化也会被
   * 跳过，下次拖窗口自动补齐 —— 权衡下来可接受。
   */
  const pausePtyForZoom = useCallback(() => {
    // 定时器句柄是可变状态，规则按不可变数据对待属于误报，显式放行
    /* eslint-disable react-hooks/immutability */
    zoomSyncPausedRef.current = true;
    if (zoomSettleTimer.current)
      clearTimeout(zoomSettleTimer.current);
    zoomSettleTimer.current = setTimeout(() => {
      zoomSettleTimer.current = null;
      zoomSyncPausedRef.current = false;
    }, 600);
    /* eslint-enable react-hooks/immutability */
  }, []);

  /**
   * 设置里的字体/字号变化后，同步到所有已打开的终端。
   *
   * 字体或字号一变，字符的宽高就跟着变，行列数必须重算 —— 否则内容会
   * 与容器错位、右侧留出一条空白。`resize` 负责 fit 并把新尺寸告知后端 PTY。
   */
  useEffect(() => {
    const family = resolveFontFamily(
      appearance.fontFamily
    );
    const theme = toXtermTheme(
      resolveColorScheme(appearance.colorScheme)
    );
    for (const session of openedRef.current) {
      // xterm 只暴露 options 这个可变对象，没有 setter —— 想改字体就只能
      // 就地赋值。react-hooks/immutability 约束的是 React 自身的数据，
      // 对第三方实例的可变配置不适用，故此处显式放行。
      /* eslint-disable react-hooks/immutability */
      session.terminal.options.fontFamily =
        family;
      session.terminal.options.fontSize =
        appearance.fontSize;
      session.terminal.options.theme = theme;
      session.terminal.options.cursorStyle =
        appearance.cursorStyle;
      session.terminal.options.cursorBlink =
        appearance.cursorBlink;
      /* eslint-enable react-hooks/immutability */
      // 命令补全开关实时同步：关掉立即收起已显示的 ghost text
      session.completion.setEnabled(
        appearance.commandCompletion
      );
    }
    // 字号变化（Ctrl+滚轮或设置页）必然改列数：挂起 PTY 同步，手势
    // 停止 600ms 后恢复，避免连续缩放触发一串 ConPTY 整屏重绘
    pausePtyForZoom();
    resize();
  }, [
    appearance.fontFamily,
    appearance.fontSize,
    appearance.colorScheme,
    appearance.commandCompletion,
    appearance.cursorStyle,
    appearance.cursorBlink,
    pausePtyForZoom,
    resize
  ]);

  /**
   * 回滚行数（scrollback）变化后，调整所有已打开终端的滚动缓冲区。
   *
   * xterm 的 `options.scrollback` 可以运行时赋值：调大立刻生效，
   * 调小则**丢弃最老的那部分历史行**（再调大也回不来）—— 这是用户
   * 自己在设置里选的，不额外确认。缓冲区大小不影响行列数，无需 resize。
   */
  useEffect(() => {
    for (const session of openedRef.current) {
      // 与字体/字号同一套路：xterm 只暴露可变的 options、没有 setter，
      // 改配置只能就地赋值（react-hooks/immutability 对第三方实例不适用）
      /* eslint-disable react-hooks/immutability */
      session.terminal.options.scrollback =
        appearance.scrollback;
      /* eslint-enable react-hooks/immutability */
    }
    console.debug(
      "[terminal] 回滚行数已应用",
      appearance.scrollback
    );
  }, [appearance.scrollback]);

  // panes/visibleId 变化后统一挂载/切换各窗格的终端。layout effect 在
  // commit 之后、浏览器绘制之前同步执行，此时宿主已由 ref 回调登记进
  // paneHostRefs，不会像手写 rAF 那样在 DOM 未更新时提前早退。
  // 直接用 state 闭包而非 ref：layout effect 先于同步 ref 的被动 effect 执行，
  // 读 ref 会拿到上一次提交的旧值。
  //
  // 每个窗格只挂自己 visibleId 那一只，其余标签的元素离树待命（与未激活
  // 标签同一套模式），切标签＝换挂 + 按窗格尺寸 fit。同一只会话只属于
  // 一个窗格，因此各窗格之间不会争夺同一个元素。
  useLayoutEffect(() => {
    for (const pane of panes) {
      const session = opened.find(
        s => s.id === pane.visibleId
      );
      const host = paneHostRefs.current.get(
        pane.id
      );
      if (!session || !host) continue;
      session.element.className =
        "terminal-instance";
      host.replaceChildren(session.element);
      const first = !session.mounted;
      if (first) {
        session.terminal.open(session.element);
        session.mounted = true;
      }
      resizeObserver.current?.observe(host);
      resize(session);
      // 只让活动窗格抢键盘焦点：挂载时顺带 focus 活动那只，
      // 其余窗格保持安静（否则新开一个窗格会把正在输入的那只抢走）
      if (pane.id === activePane?.id)
        session.terminal.focus();
    }
  }, [opened, panes, activePane?.id, resize]);

  // ---- 5. Terminal creation (uses openSearch) ----
  const createTerminal = useCallback(
    (
      session: SavedSession,
      sourceSessionId: string
    ): OpenSession => {
      const terminal = new Terminal({
        cursorBlink: appearance.cursorBlink,
        cursorStyle: appearance.cursorStyle,
        allowProposedApi: true,
        // 字体与字号取自设置；自定义字体会拼在内置字体栈前面，
        // 没装时顺着回退，不会掉成难看的默认衬线体
        fontFamily: resolveFontFamily(
          appearance.fontFamily
        ),
        fontSize: appearance.fontSize,
        lineHeight: 1.3,
        // 回滚行数取自设置（改动由上面的 effect 推送到已有终端）
        scrollback: appearance.scrollback,
        theme: toXtermTheme(
          resolveColorScheme(
            appearance.colorScheme
          )
        )
      });
      const element =
        document.createElement("div");
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      const searchAddon = new SearchAddon();
      terminal.loadAddon(searchAddon);
      searchAddon.onDidChangeResults(event =>
        search.reportResults(
          session.id,
          event.resultIndex,
          event.resultCount
        )
      );
      registerTerminalLinks(terminal, onError);
      renderTextOnlySelection(terminal, element);
      // 解释流程进行中吞掉键盘输入：期间终端坐标由流程接管，
      // 敲字会被远端回显进正在画的解释块里造成叠加
      let explaining = false;
      // cat 拦截查看进行中同样吞输入（exec 拉文件 + 高亮 + pts 注入期间）
      let viewing = false;
      // 命令补全（PSReadLine 内联预测风格）：ghost text 挂光标处，
      // → 整句接受、Ctrl+→ 按词接受；建议刷新由输出回显驱动
      const completion = attachCommandCompletion(
        terminal,
        {
          writeToPty: data => {
            invoke("terminal_write", {
              id: session.id,
              data,
              command: null
            }).catch(onError);
          },
          isInputBlocked: () =>
            disconnectedRef.current[session.id] ||
            explaining ||
            viewing,
          enabled: appearance.commandCompletion
        }
      );
      // pts 注入与 exec 共用：SSH 会话的 exec 目标 + 找该用户最新 pts 的
      // 脚本（cat 高亮、/? 解释、vim 改写都用这套回环）
      const ptsFind = `p=$(ps -u "$(whoami)" -o tty= --sort=start_time | grep pts | tail -1)`;
      const execTarget = {
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password
      };
      terminal.onData(data => {
        // 会话断开后 PTY 可能已被移除，继续向后端写只会收到
        // "终端会话不存在"的错误气泡 —— 断连的终端敲键本就无意义。
        if (
          disconnectedRef.current[session.id] ||
          explaining ||
          viewing
        ) {
          return;
        }
        let command: string | null = null;
        if (
          data === "\r" ||
          data === "\n" ||
          data === "\r\n"
        ) {
          const buffer = terminal.buffer.active;
          const line = buffer.getLine(
            buffer.baseY + buffer.cursorY
          );
          command =
            stripPrompt(
              line?.translateToString(true) ?? ""
            ) || null;
          // 快捷命令解释：SSH 会话里「命令/?」回车 → 本地拦截 Enter、
          // Ctrl+U 清掉远端输入缓冲（不执行），解释攒完后从远端写进
          // 本会话的 pts —— 输出流经 ConPTY 进它自己的屏幕缓冲，
          // 天然抗 resize 整屏重绘；此前所有本地注入方案都会被抹掉
          const trimmed = command?.trim() ?? "";
          // 提示符原文（pts 注入的收尾要把它写回输入行）
          const rawLine =
            line?.translateToString(true) ?? "";
          const cut =
            rawLine.lastIndexOf(trimmed);
          const prompt =
            cut > 0 ? rawLine.slice(0, cut) : "";
          // 记录命令历史供补全建议（/? 解释不是要执行的命令，不入历史）
          if (
            command &&
            !trimmed.endsWith("/?")
          ) {
            completion.pushHistory(command);
          }
          if (
            session.kind === "ssh" &&
            trimmed.endsWith("/?")
          ) {
            const target = trimmed
              .slice(0, -2)
              .trim();
            if (target) {
              explaining = true;
              invoke("terminal_write", {
                id: session.id,
                data: "\x15",
                command: null
              }).catch(onError);
              // 回显+标题也从远端 pts 注入（sleep 0.5 让 Ctrl+U 的
              // 清行重绘先落地，否则会被 readline 重绘抹掉）；
              // 本地写不进 ConPTY 缓冲，resize 后会丢
              // ponytail: 取该用户最新启动的 pts shell；同一用户并发
              // 多个交互会话时可能写错窗口，需比对 SSH_CLIENT 端口
              aiRunCommand(
                execTarget,
                [
                  ptsFind,
                  `sleep 0.5`,
                  `[ -n "$p" ] && cat > "/dev/$p" <<'AI_HEAD'`,
                  trimmed,
                  `\x1b[38;2;222;220;18m[AI正在分析: ${target}]\x1b[0m`,
                  `AI_HEAD`
                ].join("\n")
              ).catch(reason =>
                console.warn(
                  "[explain] pts 回显失败",
                  reason
                )
              );
              let text = "";
              // 流式增量写入：解释 chunk 节流批量写进 pts，终端上呈打字机
              // 效果。写入经队列串行化，避免 exec 乱序导致文字错位；
              // 不再做逐行着色与裁宽 —— 半行没法裁，长行交给终端自动换行
              // ponytail: 若行宽错乱成为硬需求，需远端常驻进程按行回写
              let pending = "";
              let flushTimer: ReturnType<
                typeof setTimeout
              > | null = null;
              let started = false;
              // 队列只关心先后顺序，值丢弃，用 unknown 兜住 aiRunCommand 的返回
              let queue: Promise<unknown> =
                Promise.resolve();
              const flushPending = () => {
                flushTimer = null;
                if (!pending) return;
                const chunk = pending;
                pending = "";
                queue = queue.then(() =>
                  aiRunCommand(
                    execTarget,
                    [
                      ptsFind,
                      `[ -n "$p" ] && printf '%s' '${chunk.replace(/'/g, `'\\''`)}' > "/dev/$p"`
                    ].join("\n")
                  ).catch(reason =>
                    console.warn(
                      "[explain] pts 流式写入失败",
                      reason
                    )
                  )
                );
              };
              const pushChunk = (
                chunk: string
              ) => {
                // 首批先落正文颜色码，之后整段持续同色
                pending += started
                  ? chunk
                  : `\x1b[38;2;27;186;233m${chunk}`;
                started = true;
                if (!flushTimer)
                  flushTimer = setTimeout(
                    flushPending,
                    300
                  );
              };

              void explainCommand(
                target,
                chunk => {
                  text += chunk;
                  pushChunk(chunk);
                }
              )
                .catch(reason => {
                  const message = `\n[解释失败] ${String(reason)}`;
                  text += message;
                  pushChunk(message);
                })
                .finally(() => {
                  // 停掉节流器，把余量冲出去，再在队列尾补收尾：
                  // 颜色复位（+补行尾换行）与提示符回写
                  if (flushTimer)
                    clearTimeout(flushTimer);
                  flushPending();
                  const tail = text.endsWith("\n")
                    ? "\x1b[0m"
                    : "\x1b[0m\n";
                  const esc = prompt.replace(
                    /'/g,
                    `'\\''`
                  );
                  const escTail = tail.replace(
                    /'/g,
                    `'\\''`
                  );
                  queue = queue
                    .then(() =>
                      aiRunCommand(
                        execTarget,
                        [
                          ptsFind,
                          `[ -n "$p" ] && printf '%s' '${escTail}' > "/dev/$p"`,
                          ...(prompt
                            ? [
                                `[ -n "$p" ] && printf '%s' '${esc}' > "/dev/$p"`
                              ]
                            : [])
                        ].join("\n")
                      )
                    )
                    .catch(reason =>
                      console.warn(
                        "[explain] pts 注入失败",
                        reason
                      )
                    )
                    .finally(() => {
                      explaining = false;
                    });
                });
            }
            return;
          }
          // vim/vi 查看代码：不改写用户的命令（命令行回显与远端 history
          // 保持原样），只确保 One Dark Pro 配色已部署到远端
          // ~/.vim/plugin 自动加载，然后原样放行回车。仅 SSH 会话
          // （本地 PowerShell 的 vim 是另一个世界）
          if (session.kind === "ssh") {
            if (isVimCommand(trimmed)) {
              aiRunCommand(
                execTarget,
                VIM_SCHEME_SETUP
              )
                .catch(reason =>
                  console.warn(
                    "[vim-view] 配色部署失败，vim 以默认配色打开",
                    reason
                  )
                )
                .finally(() => {
                  invoke("terminal_write", {
                    id: session.id,
                    data: "\r",
                    command: null
                  }).catch(onError);
                });
              return;
            }
            // cat 查看代码：拦截单文件 cat，exec 拉内容 → cli-highlight 转
            // One Dark Pro ANSI → 经 exec 通道 stdin 写进本会话 pts
            // （`cat > /dev/$p`，与 /? 解释同一套回环）。写 pts 从动端是
            // 终端「输出」注入：回显行、代码、提示符全部进 ConPTY 缓冲，
            // 扛得住 vim 进出 / 面板切换 / resize 的整屏重绘；stdin 走数据
            // 流分包，不受命令串 ~16KB channel request 上限，一次往返出图。
            // 开头 Ctrl+U 清掉未执行的输入行（fetch 的往返时间正好让它的
            // readline 重绘先落地，无需 sleep），注入内容首行补回显 `cat 文件`。
            const catPath =
              parseCatCommand(trimmed);
            if (catPath) {
              viewing = true;
              const quoted = catPath.replace(
                /'/g,
                `'\\''`
              );
              const plain = `cat ${catPath}`;
              invoke("terminal_write", {
                id: session.id,
                data: "\x15",
                command: null
              }).catch(onError);
              const fallback = () =>
                invoke("terminal_write", {
                  id: session.id,
                  data: `${plain}\r`,
                  command: plain
                }).catch(onError);
              aiRunCommand(
                execTarget,
                `cat -- '${quoted}'`
              )
                .then(result => {
                  if (
                    result.exitCode !== 0 ||
                    !result.stdout
                  ) {
                    // 拉取失败：放行原命令让远端给出真实报错
                    fallback();
                    return undefined;
                  }
                  return highlightToAnsi(
                    result.stdout,
                    catPath
                  ).then(code => {
                    const body = code.endsWith(
                      "\n"
                    )
                      ? code
                      : `${code}\n`;
                    return aiRunCommand(
                      execTarget,
                      [
                        ptsFind,
                        `[ -n "$p" ] && cat > "/dev/$p"`
                      ].join("\n"),
                      // 回显行 + 高亮代码 + 复位 + 提示符（readline 的
                      // 输入行已被 Ctrl+U 清空，提示符靠注入文本补画）
                      `${plain}\n${body}\x1b[0m\n${prompt}`
                    );
                  });
                })
                .catch(reason => {
                  console.warn(
                    "[cat-view] 拦截失败，回退原始命令",
                    reason
                  );
                  fallback();
                })
                .finally(() => {
                  viewing = false;
                });
              return;
            }
          }
        }
        invoke("terminal_write", {
          id: session.id,
          data,
          command
        }).catch(onError);
      });
      terminal.attachCustomKeyEventHandler(
        event => {
          // 补全接管（ghost 显示中 →/Ctrl+→）：放在 ctrl 分支前面，
          // Ctrl+→ 才不会被当普通按键放行
          if (
            event.type === "keydown" &&
            completion.consumeKeydown(event)
          ) {
            event.preventDefault();
            return false;
          }
          if (
            event.type !== "keydown" ||
            !event.ctrlKey
          )
            return true;
          const key = event.key.toLowerCase();
          if (key === "v") return false;
          if (key === "f") {
            event.preventDefault();
            search.openSearch();
            return false;
          }
          if (
            key === "c" &&
            terminal.hasSelection()
          ) {
            navigator.clipboard
              .writeText(terminal.getSelection())
              .catch(onError);
            return false;
          }
          return true;
        }
      );
      // Ctrl + 滚轮缩放字号：手势解析与提示都在 fontZoom，这里只提供
      // 「当前字号」（读实例，闭包不会读到过期设置）与写回设置的出口
      attachFontZoom({
        host: element,
        getFontSize: () =>
          terminal.options.fontSize ??
          DEFAULT_FONT_SIZE,
        applyFontSize: onFontSizeChange,
        formatHint: size =>
          t("terminal.fontSizeHint", { size })
      });
      element.addEventListener(
        "contextmenu",
        event => {
          terminalMenu.current ??=
            createTerminalMenu({
              onError,
              onFind: search.openSearch,
              onReconnect: id =>
                reconnectRef.current(id)
            });
          terminalMenu.current.show(
            event,
            terminal,
            session.id
          );
        }
      );
      element.addEventListener("mouseup", () => {
        if (
          terminal.hasSelection() &&
          !terminal.getSelection().trim()
        )
          terminal.clearSelection();
      });
      return {
        ...session,
        terminal,
        fit,
        search: searchAddon,
        completion,
        element,
        mounted: false,
        sourceSessionId
      };
    },
    [
      onError,
      search,
      appearance,
      onFontSizeChange,
      t
    ]
  );

  // ---- 6. Core session management ----
  const cancelPassword = useCallback(() => {
    setPasswordRequest(null);
  }, []);

  /**
   * 切换到某只会话：显示它所在窗格里的它，并把该窗格设为活动窗格。
   *
   * 叫 `activateTab` 而不是 `activate`：`open`/`startSession` 都有个叫
   * `activate` 的布尔参数，同名会被遮蔽，闭包里拿到的是 boolean。
   */
  const activateTab = useCallback(
    (id: string) => {
      setPanes(prev =>
        prev.map(pane =>
          pane.tabIds.includes(id)
            ? { ...pane, visibleId: id }
            : pane
        )
      );
      const owner = panesRef.current.find(pane =>
        pane.tabIds.includes(id)
      );
      if (owner) setActivePaneId(owner.id);
    },
    [setPanes]
  );

  /** 点某窗格内的标签：只切该窗格显示的会话，不抢活动窗格。 */
  const activatePaneTab = useCallback(
    (paneId: string, id: string) => {
      setPanes(prev =>
        prev.map(pane =>
          pane.id === paneId &&
          pane.tabIds.includes(id)
            ? { ...pane, visibleId: id }
            : pane
        )
      );
    },
    [setPanes]
  );

  const startSession = useCallback(
    async (
      session: SavedSession & {
        password?: string;
      },
      sourceSessionId: string,
      /** false 时不把新会话设为激活（拆分场景） */
      activate = true
    ) => {
      const current = createTerminal(
        session,
        sourceSessionId
      );
      setOpened(prev => {
        const next = [...prev, current];
        openedRef.current = next;
        return next;
      });
      setDisconnected(prev => {
        const next = { ...prev };
        delete next[session.id];
        disconnectedRef.current = next;
        return next;
      });
      if (activate) {
        // 新会话进活动窗格并立刻显示（activate=false 的拆分场景由
        // splitPaneBy 自己往新窗格写，两边不能都写）
        const paneId =
          activePaneRef.current?.id ??
          panesRef.current[0]?.id;
        if (paneId) {
          setPanes(prev =>
            prev.map(pane =>
              pane.id === paneId
                ? {
                    ...pane,
                    tabIds: pane.tabIds.includes(
                      session.id
                    )
                      ? pane.tabIds
                      : [
                          ...pane.tabIds,
                          session.id
                        ],
                    visibleId: session.id
                  }
                : pane
            )
          );
        }
      }
      // 先挂载、等尺寸稳定，再启动 PTY：PTY 直接按最终尺寸出生，首帧不再有
      // resize。ConPTY 的整屏重绘（会抹掉欢迎横幅、堆出重复提示符）因此
      // 根本不会发生
      await waitForStableSize(current.element);
      // 稳定后再 fit 一次：下面交给后端的行列数必须是最终值，
      // 否则 PTY 一生下来就与实际不符，紧接着的 resize 又要重绘
      current.fit.fit();
      try {
        await invoke("terminal_start", {
          config: {
            ...session,
            rows: current.terminal.rows,
            cols: current.terminal.cols
          }
        });
        // PTY 就是按这个尺寸出生的，先记上：随后若布局没变就不必再同步
        syncedSizes.current.set(
          current.id,
          `${current.terminal.rows}x${current.terminal.cols}`
        );
        // PTY 建好后按当前尺寸再校一次：从挂载到这一刻之间布局可能已经变了
        // （AI 面板、侧栏、字体度量），而挂载时那次 resize 会因为「会话还没
        // 建立」被后端拒掉 —— 不补这一下，PTY 就一直停在旧宽度上
        schedulePtyResize(current);
      } catch (reason) {
        setOpened(prev => {
          const next = prev.filter(
            s => s !== current
          );
          openedRef.current = next;
          return next;
        });
        onError(reason);
        return false;
      }
      return true;
    },
    [
      createTerminal,
      onError,
      schedulePtyResize,
      setPanes
    ]
  );

  const open = useCallback(
    async (
      session: SavedSession,
      sourceSessionId = session.id,
      /** false 时不把新会话设为激活（拆分场景：新会话由调用方放进新窗格） */
      activate = true
    ) => {
      const current = openedRef.current.find(
        item => item.id === session.id
      );
      if (current) {
        // 已打开：切到它所在的窗格并显示（activate(id) 内部会找归属）
        activateTab(session.id);
        return;
      }
      if (session.kind === "ssh") {
        if (session.password) {
          try {
            const plain = await invoke<string>(
              "decrypt",
              { encoded: session.password }
            );
            await startSession(
              { ...session, password: plain },
              sourceSessionId,
              activate
            );
            return;
          } catch {
            /* fall through */
          }
        }
        setPasswordRequest({
          session,
          sourceSessionId
        });
        return;
      }
      await startSession(
        session,
        sourceSessionId,
        activate
      );
    },
    [startSession, activateTab]
  );

  const submitPassword = useCallback(
    async (password: string) => {
      const request = passwordRequest;
      if (!request) return;
      setPasswordRequest(null);
      try {
        const encrypted = await invoke<string>(
          "encrypt",
          { plain: password }
        );
        onSavePassword?.(
          request.sourceSessionId,
          encrypted
        );
      } catch (reason) {
        onError(reason);
      }
      await startSession(
        { ...request.session, password },
        request.sourceSessionId
      );
    },
    [
      passwordRequest,
      onError,
      onSavePassword,
      startSession
    ]
  );

  /** 复制/拆分共用的命名：首个实例用原名，之后 (2)(3)…，避开已打开标签。 */
  const nextDupName = useCallback(
    (base: string) => {
      let n = 1;
      const nameAt = (i: number) =>
        i === 1 ? base : `${base} (${i})`;
      while (
        openedRef.current.some(
          item => item.name === nameAt(n)
        )
      )
        n++;
      return nameAt(n);
    },
    []
  );

  const duplicate = useCallback(
    async (
      session: SavedSession,
      activate = true
    ) => {
      const newId = `dup-${session.id}-${Date.now()}`;
      await open(
        {
          ...session,
          id: newId,
          name: nextDupName(session.name)
        },
        session.id,
        activate
      );
      return newId;
    },
    [open, nextDupName]
  );

  /**
   * 拆分窗格（VSCode 式）。
   *
   * @param paneId 被拆的窗格；缺省为活动窗格
   * @param direction `row` 向右、`column` 向下
   * @param id       被复制的会话；缺省取被拆窗格当前显示的那只
   * @returns 新会话 id（失败为 undefined），调用方用它聚焦新标签
   *
   * 用被拆会话的配置新起一个独立会话（独立 PTY）放进**新建的窗格**，
   * 并立刻显示它。已被拆过的会话可以再拆（每次都新开窗格）。
   */
  const splitPaneBy = useCallback(
    async (
      paneId: string,
      direction: SplitDirection,
      id?: string
    ) => {
      try {
        if (!hasLeaf(treeRef.current, paneId))
          return undefined;
        const current = openedRef.current.find(
          s =>
            s.id ===
            (id ??
              activePaneRef.current?.visibleId)
        );
        // 已断开的会话拆出去也只是一块死屏，不开新窗格
        if (
          !current ||
          disconnectedRef.current[current.id]
        )
          return undefined;
        // 只取会话定义字段（密码若是明文直接复用，不再弹密码框）；
        // 运行时字段（terminal/element 等）不能进后端 config
        const stamp = Date.now();
        const config: SavedSession = {
          id: `split-${current.id}-${stamp}`,
          name: nextDupName(current.name),
          kind: current.kind,
          host: current.host,
          port: current.port,
          username: current.username,
          password: current.password
        };
        const ok = await startSession(
          config,
          current.sourceSessionId,
          false
        );
        if (!ok) return undefined;
        const newPaneId = `pane-${stamp}`;
        // 先落布局再落标签：setTreeAndSync 会给新 paneId 补一条空记录，
        // 紧接着这次 setPanes 才把新标签写进去
        setTreeAndSync(prev =>
          splitPane(
            prev,
            paneId,
            direction,
            newPaneId,
            `split-${stamp}`
          )
        );
        setPanes(prev =>
          prev.map(pane =>
            pane.id === newPaneId
              ? {
                  ...pane,
                  tabIds: [config.id],
                  visibleId: config.id
                }
              : pane
          )
        );
        setActivePaneId(newPaneId);
        console.info(
          `[terminal] 拆分窗格 ${paneId} → ${newPaneId}（${direction}）`
        );
        // 返回新会话 id：调用方要用它聚焦 —— 新 id 是 split-…，
        // 拿被拆会话的 id 选中会让胶囊留在原窗格
        return config.id;
      } catch (error) {
        // 拆分失败要露出完整错误（含 TypeError 堆栈摘要），否则用户只看到
        // 毫无线索的气泡甚至毫无反应
        console.error(
          "[terminal] 拆分窗格失败",
          error
        );
        onError(error);
      }
      return undefined;
    },
    [
      nextDupName,
      onError,
      setPanes,
      setTreeAndSync,
      startSession
    ]
  );

  /**
   * 拖标签在窗格之间移动：本质是 tabIds 成员关系的搬移。
   *
   * 进入目标窗格＝成为该窗格的新标签并立刻可见；离开时若它正可见，
   * 可见位交给该窗格剩下的第一只。会话只属于一个窗格，所以源窗格必然
   * 要把它摘掉 —— 若那是源窗格最后一个标签，源窗格就地折叠（见 close）。
   */
  const moveTab = useCallback(
    (id: string, toPaneId: string) => {
      const from = panesRef.current.find(pane =>
        pane.tabIds.includes(id)
      );
      if (!from) return;
      if (from.id === toPaneId) return;
      if (
        !panesRef.current.some(
          pane => pane.id === toPaneId
        )
      )
        return;
      setPanes(prev =>
        prev.map(pane => {
          if (pane.id === from.id) {
            const tabIds = pane.tabIds.filter(
              tab => tab !== id
            );
            return {
              ...pane,
              tabIds,
              visibleId:
                pane.visibleId === id
                  ? (tabIds[0] ?? "")
                  : pane.visibleId
            };
          }
          if (pane.id === toPaneId) {
            return {
              ...pane,
              tabIds: [...pane.tabIds, id],
              visibleId: id
            };
          }
          return pane;
        })
      );
      console.info(
        `[terminal] 标签 ${id} 从窗格 ${from.id} 移到 ${toPaneId}`
      );
    },
    [setPanes]
  );

  /**
   * 窗格内拖拽换位：把 id 插到 beforeId 之前，beforeId 为 null 表示
   * 追加到末尾（拖到最后一个标签右侧的空白处）。
   *
   * 只动这个窗格的 tabIds —— 标签顺序是**每窗格各自**的，与 opened
   * 的全局顺序无关（opened 只是"哪些会话开着"的清单）。
   */
  const reorderTab = useCallback(
    (
      paneId: string,
      id: string,
      beforeId: string | null
    ) => {
      const pane = panesRef.current.find(
        item => item.id === paneId
      );
      if (!pane) return;
      const from = pane.tabIds.indexOf(id);
      if (from < 0) return;
      const next = [...pane.tabIds];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      const to =
        beforeId === null
          ? next.length
          : next.indexOf(beforeId);
      if (to < 0) return;
      next.splice(to, 0, moved);
      setPanes(prev =>
        prev.map(item =>
          item.id === paneId
            ? { ...item, tabIds: next }
            : item
        )
      );
    },
    [setPanes]
  );

  /**
   * 拖分隔条：按 splitId 写回比例。树的操作是纯函数（paneLayout），
   * 这里只负责把新树塞进 state。
   */
  const setPaneRatio = useCallback(
    (splitId: string, ratio: number) => {
      setTree(prev =>
        setSplitRatio(prev, splitId, ratio)
      );
    },
    [setTree]
  );

  /**
   * 把键盘焦点交回指定会话的终端。
   *
   * 切换标签时挂载用的 layout effect 已经 focus 过一次，但 RAC 的 Tab 会在
   * press 阶段把焦点留在自己身上，且点击**已激活**的标签不会改变 activeId、
   * layout effect 根本不跑。两种情况下都需要由点击方显式抢回焦点。
   */
  const focusTerminal = useCallback(
    (id: string) => {
      openedRef.current
        .find(session => session.id === id)
        ?.terminal.focus();
    },
    []
  );

  const close = useCallback(
    async (id: string) => {
      const index = openedRef.current.findIndex(
        session => session.id === id
      );
      if (index < 0) return;
      // 关掉标签就别再重连它：清掉等待中的退避定时器
      cancelReconnect(id);
      // 待发送的尺寸同步也没必要了
      cancelPtyResize(id);
      // 从所属窗格里摘掉这个标签；若它正可见，可见位交给剩下的第一只。
      // 摘完窗格空了 → 把窗格从布局树里折叠掉（树会少一级），
      // 但树里只剩一个窗格时不能折叠，否则变成空树。
      const owner = panesRef.current.find(pane =>
        pane.tabIds.includes(id)
      );
      let emptiedPaneId = "";
      if (owner) {
        const rest = owner.tabIds.filter(
          tab => tab !== id
        );
        emptiedPaneId =
          rest.length === 0 ? owner.id : "";
        setPanes(prev =>
          prev.map(pane =>
            pane.id === owner.id
              ? {
                  ...pane,
                  tabIds: rest,
                  visibleId:
                    pane.visibleId === id
                      ? (rest[0] ?? "")
                      : pane.visibleId
                }
              : pane
          )
        );
      }
      await invoke("terminal_close", {
        id
      }).catch(onError);
      openedRef.current[
        index
      ]?.terminal.dispose();
      setOpened(prev => {
        const next = prev.filter(
          s => s.id !== id
        );
        openedRef.current = next;
        return next;
      });
      // 折叠空窗格：放在 setOpened 之后，这样 setTreeAndSync 里的
      // setPanes 拿到的是已经摘掉标签的 panes，不会把幽灵标签复活
      if (
        emptiedPaneId &&
        panesRef.current.length > 1
      ) {
        const remaining = panesRef.current.filter(
          pane => pane.id !== emptiedPaneId
        );
        setTreeAndSync(prev =>
          removePane(prev, emptiedPaneId)
        );
        // 活动窗格被折叠掉了 → 活动权交给剩下的第一个
        if (
          activePaneIdRef.current ===
          emptiedPaneId
        ) {
          setActivePaneId(remaining[0]?.id ?? "");
        }
        console.info(
          `[terminal] 窗格 ${emptiedPaneId} 已空，折叠`
        );
      }
    },
    [
      onError,
      setPanes,
      setTreeAndSync,
      cancelReconnect,
      cancelPtyResize
    ]
  );

  /**
   * 批量关闭多个会话。逐个走单个关闭流程（杀 PTY、dispose、移出列表）。
   * close 内部会把 activeId 切到相邻标签，React 会对循环中的中间状态
   * 做批处理，最终落在保留的标签上。
   */
  const closeMany = useCallback(
    async (ids: string[]) => {
      for (const id of ids) await close(id);
    },
    [close]
  );

  // ---- 7. Global listeners ----
  // 全局监听只随挂载注册一次。effect 依赖里的 search/resize/重连判定
  // 每渲染都可能变，走 ref 取最新值 —— 旧写法把 search 放进依赖，启动
  // 爆发期的连续重渲染会让 effect 反复重跑，而 cleanup 跑在 await listen
  // 完成之前（此时列表还是空的），旧监听器成了孤儿：每个输出块被重复
  // 写进终端多次，表现为回显、提示符成双成对
  const searchRef = useRef(search);
  const resizeRef = useRef(resize);
  const handleDisconnectRef = useRef(
    handleDisconnect
  );
  const tRef = useRef(t);
  // ref 镜像的同步 effect 要声明在监听 effect **之前**：同一提交里
  // effect 按声明顺序执行，先同步 ref、监听 effect 才拿得到最新值
  useEffect(() => {
    searchRef.current = search;
    resizeRef.current = resize;
    handleDisconnectRef.current =
      handleDisconnect;
    tRef.current = t;
  }, [search, resize, handleDisconnect, t]);
  useEffect(() => {
    // cleanup 可能在不同的提交里执行，先把要清理的 ref 取值固定下来
    const ptyTimers = ptyResizeTimers.current;
    // ResizeObserver 必须**同步**建好：挂载用的 layout effect 会立刻 observe
    // 宿主，如果这里还排在 await 后面，那一次 observe 就打在 undefined 上，
    // 之后宿主尺寸变化再也没人触发 resize —— 本地与 PTY 尺寸永久脱节，
    // 表现就是远端按旧宽度换行、屏幕内容错位、提示符挤成一堆
    const observer = new ResizeObserver(() =>
      resizeRef.current()
    );
    resizeObserver.current = observer;
    let disposed = false;
    const setup = async () => {
      const listeners = await Promise.all([
        listen<{ id: string; data: string }>(
          "terminal-output",
          ({ payload }) => {
            // 拆分会话是独立会话，输出天然只写它自己这一只终端
            const session =
              openedRef.current.find(
                ({ id }) => id === payload.id
              );
            if (!session) return;
            // 先让补全识别备用屏切换（vim/top 等全屏应用期间不弹建议）
            session.completion.observeOutput(
              payload.data
            );
            session.terminal.write(payload.data);
          }
        ),
        listen<{
          id: string;
          code: number | null;
        }>("terminal-exit", ({ payload }) => {
          const { id, code } = payload;
          setDisconnected(prev => {
            const next = {
              ...prev,
              [id]: true
            };
            disconnectedRef.current = next;
            return next;
          });
          const session = openedRef.current.find(
            item => item.id === id
          );
          if (session) {
            session.terminal.options.cursorBlink = false;
            session.terminal.write(
              `\r\n\x1b[38;5;244m${tRef.current("terminal.exited")}\x1b[0m\r\n`
            );
          }
          // 只有 ssh 的连接错误（退出码 255）才自动重连：本地会话退出、
          // ssh 正常 exit 都是用户意图，就此收工
          handleDisconnectRef.current(
            session,
            code
          );
        })
      ]);
      // 挂载期的连续重渲染可能在 listen 完成前就跑过 cleanup：迟到的
      // 注册必须立刻注销，否则就是孤儿监听（输出被重复写入）
      if (disposed) {
        listeners.forEach(u => u());
        return;
      }
      unlisteners.current = listeners;
      documentShortcutHandler.current = (
        event: KeyboardEvent
      ) => {
        const key = event.key.toLowerCase();
        const ctrl =
          event.ctrlKey || event.metaKey;
        if (ctrl && key === "f") {
          event.preventDefault();
          searchRef.current.openSearch();
          return;
        }
        if (
          event.key === "F12" ||
          (ctrl && event.shiftKey && key === "i")
        ) {
          event.preventDefault();
          invoke("open_devtools").catch(() => {});
        }
      };
      window.addEventListener(
        "keydown",
        documentShortcutHandler.current,
        true
      );
    };
    setup();
    return () => {
      disposed = true;
      unlisteners.current.forEach(u => u());
      unlisteners.current = [];
      observer.disconnect();
      // 待执行的重连定时器一并清掉：组件没了就不该再拉起 PTY
      cancelAllReconnects();
      // 待发送的 PTY 尺寸同步同样作废
      ptyTimers.forEach(timer =>
        clearTimeout(timer)
      );
      ptyTimers.clear();
      if (documentShortcutHandler.current)
        window.removeEventListener(
          "keydown",
          documentShortcutHandler.current,
          true
        );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只随挂载注册一次，回调经 ref 取最新值（见上）
  }, []);

  return {
    opened,
    activeId,
    active,
    disconnected,
    /** 手动重连（断线后右键终端里的「重新连接」） */
    reconnect: reconnectSession,
    open,
    duplicate,
    activate: activateTab,
    focusTerminal,
    close,
    closeMany,
    setPtyResizePaused,
    // ---- 窗格网格 ----
    panes,
    tree,
    activePaneId: activePane?.id ?? "",
    setPaneHost,
    setPaneRatio,
    splitPane: splitPaneBy,
    activatePaneTab,
    setActivePaneId,
    moveTab,
    reorderTab,
    passwordRequest,
    submitPassword,
    cancelPassword,
    // 查找相关的状态与操作都来自 useTerminalSearch
    searchOpen: search.searchOpen,
    searchError: search.searchError,
    searchResult,
    searchCaseSensitive:
      search.searchCaseSensitive,
    searchRegex: search.searchRegex,
    openSearch: search.openSearch,
    closeSearch: search.closeSearch,
    toggleCaseSensitive:
      search.toggleCaseSensitive,
    toggleRegex: search.toggleRegex,
    search: search.search
  };
}
