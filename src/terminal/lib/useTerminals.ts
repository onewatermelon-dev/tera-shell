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
  parseCatCommand,
  parseVimCommand,
  VIM_SCHEME_SETUP
} from "@/terminal/lib/catView";
import { renderTextOnlySelection } from "@/terminal/lib/terminalSelection";
import { stripPrompt } from "@/terminal/lib/stripPrompt";
import { createTerminalMenu } from "@/terminal/lib/terminalContextMenu";
import { useTerminalSearch } from "@/terminal/lib/useTerminalSearch";
import {
  resolveFontFamily,
  type AppSettings
} from "@/settings/lib/settings";
import {
  resolveColorScheme,
  toXtermTheme
} from "@/terminal/lib/colorSchemes";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

// 会话类型定义在 terminalTypes，这里重新导出，外部仍从 useTerminals 引入
export type { OpenSession } from "@/terminal/lib/terminalTypes";

export function useTerminals(
  onError: (reason: unknown) => void,
  onSavePassword:
    | ((
        sourceSessionId: string,
        encrypted: string
      ) => void)
    | undefined,
  /** 终端外观设置：字体、字号与配色随之变化，整批终端一起更新 */
  appearance: Pick<
    AppSettings,
    "fontFamily" | "fontSize" | "colorScheme"
  >
) {
  const [opened, setOpened] = useState<
    OpenSession[]
  >([]);
  const [activeId, setActiveId] = useState("");
  const [disconnected, setDisconnected] =
    useState<Record<string, boolean>>({});
  const [passwordRequest, setPasswordRequest] =
    useState<{
      session: SavedSession;
      sourceSessionId: string;
    } | null>(null);
  const openedRef = useRef(opened);
  /** 解释落画期间按会话扣住远端输出的队列（见 terminal-output 监听） */
  const activeIdRef = useRef(activeId);
  const disconnectedRef = useRef(disconnected);
  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    disconnectedRef.current = disconnected;
  }, [disconnected]);

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
  const terminalHostRef =
    useRef<HTMLElement | null>(null);
  // 终端右键菜单（命令式 DOM，逻辑见 terminalContextMenu）：
  // 首次用到时才创建，那时 openSearch 已经定义好
  const terminalMenu = useRef<ReturnType<
    typeof createTerminalMenu
  > | null>(null);

  const setTerminalHost = useCallback(
    (el: HTMLElement | null) => {
      terminalHostRef.current = el;
    },
    []
  );

  // ---- 拆分标签组 ----
  // splitIds = 右侧第二个标签组的标签列表（按加入顺序）：拆分 = 用同一份
  // 配置新起一个独立会话（独立 PTY，VSCode 式），不是同一 PTY 的镜像 ——
  // 单 PTY 喂两个不同宽度的视图必然互相重排（拖分隔线时提示行被重复推
  // 下去），独立 PTY 各管各的尺寸就没有这类问题。拖左栏标签进组也能加
  // 标签；关掉组内标签就是关掉该会话（标签上的 ×）。
  const [splitIds, setSplitIdsState] = useState<
    string[]
  >([]);
  // ref 供闭包读最新值（split/close/输出监听里判断）
  const splitIdsRef = useRef<string[]>([]);
  const setSplitIds = useCallback(
    (ids: string[]) => {
      splitIdsRef.current = ids;
      setSplitIdsState(ids);
    },
    []
  );
  // 组内当前显示在拆分窗格里的那一只。与会话栏的左栏（activeId）互不干扰：
  // 两栏各有各的可见会话，点谁的标签/窗格就只动谁。
  const [splitVisibleId, setSplitVisibleState] =
    useState("");
  const splitVisibleIdRef = useRef("");
  const setSplitVisible = useCallback(
    (id: string) => {
      splitVisibleIdRef.current = id;
      setSplitVisibleState(id);
    },
    []
  );
  // 拆分窗格的宿主：整组只有一个窗格，切换标签只是换挂的元素
  const splitHostRef = useRef<HTMLElement | null>(
    null
  );
  const setSplitHost = useCallback(
    (el: HTMLElement | null) => {
      splitHostRef.current = el;
    },
    []
  );

  const active = opened.find(
    s => s.id === activeId
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
  const resize = useCallback(
    (current?: OpenSession) => {
      // 显式指定就只动它；否则两栏各自跟一次 —— ResizeObserver 拖分隔线 /
      // 窗口缩放都会触发，只 fit 主栏会把拆分窗格留在旧尺寸。
      // 已断开的会话不再向后端 resize：PTY 可能已被移除，
      // 调用只会产生"终端会话不存在"的错误气泡
      const targets = current
        ? [current]
        : [
            openedRef.current.find(
              s => s.id === activeIdRef.current
            ),
            openedRef.current.find(
              s =>
                s.id === splitVisibleIdRef.current
            )
          ];
      for (const session of targets) {
        if (
          session &&
          !disconnectedRef.current[session.id]
        ) {
          session.fit.fit();
          session.terminal.scrollToBottom();
          // 抽屉打开期间暂停向 PTY 同步行高：ConPTY 收缩会丢掉屏幕
          // 上方内容，恢复时整屏重绘把历史打回空白；只缩本地视口即可，
          // 远端布局保持不变（见 setPtyResizePaused）
          if (ptyPausedRef.current) continue;
          invoke("terminal_resize", {
            id: session.id,
            rows: session.terminal.rows,
            cols: session.terminal.cols
          }).catch(() => {});
        }
      }
    },
    []
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
      /* eslint-enable react-hooks/immutability */
    }
    resize();
  }, [
    appearance.fontFamily,
    appearance.fontSize,
    appearance.colorScheme,
    resize
  ]);

  // opened/activeId 变化后统一挂载/切换终端。layout effect 在 commit 之后、
  // 浏览器绘制之前同步执行，此时 terminalHostRef 已由 ref 回调赋值，
  // 不会像手写 rAF 那样在 DOM 未更新时提前早退。
  // 直接用 state 闭包而非 ref：layout effect 先于同步 ref 的被动 effect 执行，
  // 读 ref 会拿到上一次提交的旧值。
  useLayoutEffect(() => {
    const current = opened.find(
      s => s.id === activeId
    );
    const host = terminalHostRef.current;
    if (!current || !host) return;
    // 拆分组挂的是自己宿主里的会话（与主栏不同一只），不存在元素争夺
    current.element.className =
      "terminal-instance";
    host.replaceChildren(current.element);
    const first = !current.mounted;
    if (first) {
      current.terminal.open(current.element);
      current.mounted = true;
    }
    resizeObserver.current?.observe(host);
    resize(current);
    current.terminal.focus();
  }, [opened, activeId, resize, splitIds]);

  // 拆分窗格的挂载：只挂组内可见的那一只，其余标签的元素离树待命
  // （与左栏未激活标签同一套模式），切标签＝换挂 + 按窗格尺寸 fit。
  // 左栏宿主只挂激活会话、拆分组不带激活会话，两边不会争夺元素；
  // 组清空时宿主 div 由 React 整体卸载，无需手动清空。
  useLayoutEffect(() => {
    const session = opened.find(
      s => s.id === splitVisibleId
    );
    const host = splitHostRef.current;
    if (!session || !host) return;
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
  }, [opened, splitVisibleId, resize]);

  // ---- 5. Terminal creation (uses openSearch) ----
  const createTerminal = useCallback(
    (
      session: SavedSession,
      sourceSessionId: string
    ): OpenSession => {
      const terminal = new Terminal({
        cursorBlink: true,
        allowProposedApi: true,
        // 字体与字号取自设置；自定义字体会拼在内置字体栈前面，
        // 没装时顺着回退，不会掉成难看的默认衬线体
        fontFamily: resolveFontFamily(
          appearance.fontFamily
        ),
        fontSize: appearance.fontSize,
        lineHeight: 1.3,
        scrollback: 5000,
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
          // vim/vi 查看代码：远端 vim 默认 syntax off 是白字的根源 ——
          // 改写成 `-c 'syntax on'` 放行，远端自己按 ANSI 渲染配色。
          // 仅 SSH 会话（本地 PowerShell 的 vim 是另一个世界）
          if (session.kind === "ssh") {
            const rewritten =
              parseVimCommand(trimmed);
            if (rewritten) {
              // 先确保远端有 One Dark Pro colorscheme（只部署一次，
              // 已存在则跳过），改写命令挂上它；部署失败退纯 syntax on
              aiRunCommand(
                execTarget,
                VIM_SCHEME_SETUP
              )
                .then(
                  result => result.exitCode === 0
                )
                .catch(() => false)
                .then(schemeReady => {
                  const cmd = parseVimCommand(
                    trimmed,
                    schemeReady
                  );
                  invoke("terminal_write", {
                    id: session.id,
                    // Ctrl+U 清掉原行再写改写命令，一次写入完成回车
                    data: `\x15${cmd}\r`,
                    command: cmd
                  }).catch(onError);
                });
              return;
            }
            // cat 查看代码：拦截单文件 cat，exec 拉内容 → cli-highlight 转
            // One Dark Pro ANSI → 直接写进 xterm（换行转 \r\n）。曾经尝试
            // heredoc/base64 注入远端 bash stdin：交互 bash 的 readline 自
            // 管显示（raw 模式），stty -echo 拦不住，内容全被 readline 画
            // 出来搅成乱码 —— 本地注入是唯一干净的路径。代价：远端有输出
            // 或 resize 重绘时内容会被覆盖（只在查看后改窗口大小才发生）
            const catPath =
              parseCatCommand(trimmed);
            if (catPath) {
              viewing = true;
              invoke("terminal_write", {
                id: session.id,
                data: "\x15",
                command: null
              }).catch(onError);
              const quoted = catPath.replace(
                /'/g,
                `'\\''`
              );
              const plain = `cat ${catPath}`;
              aiRunCommand(
                execTarget,
                `cat -- '${quoted}'`
              )
                .then(result => {
                  if (
                    result.exitCode !== 0 ||
                    !result.stdout
                  ) {
                    // 拉取失败：放行原命令，让远端给出真实报错
                    invoke("terminal_write", {
                      id: session.id,
                      data: `${plain}\r`,
                      command: plain
                    }).catch(onError);
                    return undefined;
                  }
                  return highlightToAnsi(
                    result.stdout,
                    catPath
                  ).then(code =>
                    // 本地显示：写 xterm 屏幕（terminal.write），
                    // 不是 invoke("terminal_write") —— 那是 PTY 输入，
                    // 会把内容发给 bash 当命令执行。多行必须 \n → \r\n
                    terminal.write(
                      `${code
                        .replace(/\r/g, "")
                        .replace(
                          /\n/g,
                          "\r\n"
                        )}\r\n`
                    )
                  );
                })
                .catch(reason =>
                  console.warn(
                    "[cat-view] 拦截失败，回退原始命令",
                    reason
                  )
                )
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
      element.addEventListener(
        "contextmenu",
        event => {
          terminalMenu.current ??=
            createTerminalMenu({
              onError,
              onFind: search.openSearch
            });
          terminalMenu.current.show(
            event,
            terminal
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
        element,
        mounted: false,
        sourceSessionId
      };
    },
    [onError, search, appearance]
  );

  // ---- 6. Core session management ----
  const cancelPassword = useCallback(() => {
    setPasswordRequest(null);
  }, []);

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
      if (activate) setActiveId(session.id);
      // 先挂载再启动 PTY：等两帧让 open+fit 落定，PTY 直接按最终尺寸出生。
      // 这样首帧不再有 resize，ConPTY 的整屏重绘（会抹掉欢迎横幅）根本不会发生
      await new Promise<void>(resolve =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve())
        )
      );
      try {
        await invoke("terminal_start", {
          config: {
            ...session,
            rows: current.terminal.rows,
            cols: current.terminal.cols
          }
        });
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
    [createTerminal, onError]
  );

  const open = useCallback(
    async (
      session: SavedSession,
      sourceSessionId = session.id,
      /** false 时不把新会话设为激活（拆分场景：新会话只进右侧栏） */
      activate = true
    ) => {
      const current = openedRef.current.find(
        item => item.id === session.id
      );
      if (current) {
        setActiveId(session.id);
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
    [startSession]
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

  /** 向右拆分（id 缺省为当前激活会话，右键标签时传被右键的那只）：
   *  用被拆会话的配置新起一个独立会话（独立 PTY）放进拆分标签组，
   *  并立刻显示它；已在组内的会话忽略。不切换左栏的激活会话。
   *  组内会话不进左栏标签列表，关掉它就是移出一个标签（close）。 */
  const split = useCallback(
    async (id?: string) => {
      try {
        const target = id ?? activeIdRef.current;
        if (
          !target ||
          splitIdsRef.current.includes(target)
        )
          return;
        const current = openedRef.current.find(
          s => s.id === target
        );
        // 已断开的会话拆出去也只是一块死屏，不开新栏
        if (
          !current ||
          disconnectedRef.current[current.id]
        )
          return;
        // 只取会话定义字段（密码若是明文直接复用，不再弹密码框）；
        // 运行时字段（terminal/element 等）不能进后端 config
        const config: SavedSession = {
          id: `split-${current.id}-${Date.now()}`,
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
        setSplitIds([
          ...splitIdsRef.current,
          config.id
        ]);
        setSplitVisible(config.id);
        // 返回新会话 id：调用方要用它聚焦 —— 新 id 是 split-…，
        // 拿被拆会话的 id 选中会让胶囊落回左栏
        return config.id;
      } catch (error) {
        // 拆分失败要露出完整错误（含 TypeError 堆栈摘要），否则用户只看到
        // 毫无线索的气泡甚至毫无反应
        onError(error);
      }
      return undefined;
    },
    [
      nextDupName,
      onError,
      setSplitIds,
      setSplitVisible,
      startSession
    ]
  );

  const activate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  /** 点拆分组内的标签：切换拆分窗格里显示的会话。 */
  const activateSplit = useCallback(
    (id: string) => setSplitVisible(id),
    [setSplitVisible]
  );

  /** 拖标签在左栏与拆分标签组之间移动：本质是 splitIds 成员关系的搬移。
   *  进组＝成为组内新标签并立刻可见；出组回左栏时，若它正可见，
   *  可见位交给组内剩下的第一只。激活会话被拖进组时，把激活权交给
   *  左栏剩下的第一只会话 —— 组内会话不可激活，左栏不能没有激活会话。 */
  const moveTab = useCallback(
    (id: string, to: "main" | "split") => {
      const inSplit =
        splitIdsRef.current.includes(id);
      if (to === "split" && !inSplit) {
        setSplitIds([...splitIdsRef.current, id]);
        setSplitVisible(id);
        if (activeIdRef.current === id) {
          // setSplitIds 同步写了 ref：这里 rest 已排除组内会话
          const rest = openedRef.current.filter(
            s =>
              s.id !== id &&
              !splitIdsRef.current.includes(s.id)
          );
          setActiveId(rest[0]?.id ?? "");
        }
      } else if (to === "main" && inSplit) {
        const next = splitIdsRef.current.filter(
          split => split !== id
        );
        setSplitIds(next);
        if (splitVisibleIdRef.current === id)
          setSplitVisible(next[0] ?? "");
      }
    },
    [setSplitIds, setSplitVisible]
  );

  /** 左栏内拖拽换位：把 id 插到 beforeId 之前，beforeId 为 null 表示
   *  追加到末尾（拖到最后一个标签右侧的空白处）。左栏标签顺序就是
   *  opened 的数组顺序，换位＝重排这个数组。 */
  const reorderTab = useCallback(
    (id: string, beforeId: string | null) => {
      const list = openedRef.current;
      const from = list.findIndex(
        s => s.id === id
      );
      if (from < 0) return;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      const to =
        beforeId === null
          ? next.length
          : next.findIndex(
              s => s.id === beforeId
            );
      if (to < 0) return;
      next.splice(to, 0, moved);
      openedRef.current = next;
      setOpened(next);
    },
    []
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
      // 关闭的是组内会话：移出一个标签；若它正可见，可见位交给
      // 剩下的第一只（组空了就是 ""，右侧窗格整体消失）
      if (splitIdsRef.current.includes(id)) {
        const next = splitIdsRef.current.filter(
          split => split !== id
        );
        setSplitIds(next);
        if (splitVisibleIdRef.current === id)
          setSplitVisible(next[0] ?? "");
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
      if (activeIdRef.current === id) {
        // 兜底不能落在拆分标签组的会话上：它的元素挂在拆分窗格宿主，
        // 一旦激活会和左栏宿主争夺元素
        const rest = openedRef.current.filter(
          s => !splitIdsRef.current.includes(s.id)
        );
        setActiveId(
          rest[Math.max(0, index - 1)]?.id ||
            rest[0]?.id ||
            ""
        );
      }
    },
    [onError, setSplitIds, setSplitVisible]
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
  useEffect(() => {
    const setup = async () => {
      unlisteners.current = await Promise.all([
        listen<{ id: string; data: string }>(
          "terminal-output",
          ({ payload }) => {
            // 拆分会话是独立会话，输出天然只写它自己这一只终端
            const session =
              openedRef.current.find(
                ({ id }) => id === payload.id
              );
            if (!session) return;
            session.terminal.write(payload.data);
          }
        ),
        listen<string>(
          "terminal-exit",
          ({ payload }) => {
            setDisconnected(prev => {
              const next = {
                ...prev,
                [payload]: true
              };
              disconnectedRef.current = next;
              return next;
            });
            const session =
              openedRef.current.find(
                ({ id }) => id === payload
              );
            if (session) {
              session.terminal.options.cursorBlink = false;
              session.terminal.write(
                "\r\n\x1b[38;5;244m[会话已结束]\x1b[0m\r\n"
              );
            }
          }
        )
      ]);
      resizeObserver.current = new ResizeObserver(
        () => resize()
      );
      documentShortcutHandler.current = (
        event: KeyboardEvent
      ) => {
        const key = event.key.toLowerCase();
        const ctrl =
          event.ctrlKey || event.metaKey;
        if (ctrl && key === "f") {
          event.preventDefault();
          search.openSearch();
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
      unlisteners.current.forEach(u => u());
      resizeObserver.current?.disconnect();
      if (documentShortcutHandler.current)
        window.removeEventListener(
          "keydown",
          documentShortcutHandler.current,
          true
        );
    };
  }, [resize, search]);

  return {
    opened,
    activeId,
    active,
    setTerminalHost,
    disconnected,
    open,
    duplicate,
    activate,
    focusTerminal,
    close,
    closeMany,
    setPtyResizePaused,
    splitIds,
    splitVisibleId,
    activateSplit,
    setSplitHost,
    split,
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
