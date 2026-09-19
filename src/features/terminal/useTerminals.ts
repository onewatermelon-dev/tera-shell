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
import type { SavedSession } from "@/features/sessions/session";
import { registerTerminalLinks } from "@/features/terminal/terminalLinks";
import { renderTextOnlySelection } from "@/features/terminal/terminalSelection";
import { stripPrompt } from "@/features/terminal/stripPrompt";
import { createTerminalMenu } from "@/features/terminal/terminalContextMenu";
import { useTerminalSearch } from "@/features/terminal/useTerminalSearch";
import {
  resolveFontFamily,
  type AppSettings
} from "@/features/settings/settings";
import type { OpenSession } from "@/features/terminal/terminalTypes";

// 会话类型定义在 terminalTypes，这里重新导出，外部仍从 useTerminals 引入
export type { OpenSession } from "@/features/terminal/terminalTypes";

export function useTerminals(
  onError: (reason: unknown) => void,
  onSavePassword:
    | ((
        sourceSessionId: string,
        encrypted: string
      ) => void)
    | undefined,
  /** 终端外观设置：字体与字号随之变化，整批终端一起更新 */
  appearance: Pick<
    AppSettings,
    "fontFamily" | "fontSize"
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
  const resize = useCallback(
    (current?: OpenSession) => {
      const session =
        current ??
        openedRef.current.find(
          s => s.id === activeIdRef.current
        );
      if (!session) return;
      session.fit.fit();
      session.terminal.scrollToBottom();
      invoke("terminal_resize", {
        id: session.id,
        rows: session.terminal.rows,
        cols: session.terminal.cols
      }).catch(() => {});
    },
    []
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
    for (const session of openedRef.current) {
      // xterm 只暴露 options 这个可变对象，没有 setter —— 想改字体就只能
      // 就地赋值。react-hooks/immutability 约束的是 React 自身的数据，
      // 对第三方实例的可变配置不适用，故此处显式放行。
      /* eslint-disable react-hooks/immutability */
      session.terminal.options.fontFamily =
        family;
      session.terminal.options.fontSize =
        appearance.fontSize;
      /* eslint-enable react-hooks/immutability */
    }
    resize();
  }, [
    appearance.fontFamily,
    appearance.fontSize,
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
    current.element.className =
      "terminal-instance";
    host.replaceChildren(current.element);
    if (!current.mounted) {
      current.terminal.open(current.element);
      if (current.kind === "ssh") {
        current.terminal.writeln(
          "\x1b[38;5;244m密码输入不会显示字符或 *，输入完成后直接按 Enter。\x1b[0m"
        );
      }
      current.mounted = true;
    }
    resizeObserver.current?.observe(host);
    resize(current);
    current.terminal.focus();
  }, [opened, activeId, resize]);

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
        theme: {
          background: "#0b0e14",
          foreground: "#c9d1d9",
          cursor: "rgb(41 103 206)",
          selectionBackground: "#00000000",
          selectionInactiveBackground:
            "#00000000",
          scrollbarSliderBackground:
            "rgb(41 103 206)",
          scrollbarSliderHoverBackground:
            "rgb(41 103 206)",
          scrollbarSliderActiveBackground:
            "rgb(41 103 206)"
        }
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
      terminal.onData(data => {
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
      sourceSessionId: string
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
      try {
        await invoke("terminal_start", {
          config: session
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
        return;
      }
      setActiveId(session.id);
    },
    [createTerminal, onError]
  );

  const open = useCallback(
    async (
      session: SavedSession,
      sourceSessionId = session.id
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
              sourceSessionId
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
        sourceSessionId
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

  const duplicate = useCallback(
    async (session: SavedSession) => {
      let n = 1;
      const nameAt = (i: number) =>
        i === 1
          ? session.name
          : `${session.name} (${i})`;
      while (
        openedRef.current.some(
          item => item.name === nameAt(n)
        )
      )
        n++;
      await open(
        {
          ...session,
          id: `dup-${session.id}-${Date.now()}`,
          name: nameAt(n)
        },
        session.id
      );
    },
    [open]
  );

  const activate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

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
      if (activeIdRef.current === id)
        setActiveId(
          openedRef.current[
            Math.max(0, index - 1)
          ]?.id || ""
        );
    },
    [onError]
  );

  // ---- 7. Global listeners ----
  useEffect(() => {
    const setup = async () => {
      unlisteners.current = await Promise.all([
        listen<{ id: string; data: string }>(
          "terminal-output",
          ({ payload }) =>
            openedRef.current
              .find(({ id }) => id === payload.id)
              ?.terminal.write(payload.data)
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
