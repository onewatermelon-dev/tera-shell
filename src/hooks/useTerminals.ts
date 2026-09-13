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
import type { SavedSession } from "@/domain/session";
import {
  clearSearchTextOverlays,
  paintSearchTextOverlays,
  sweepStaleDecorations
} from "@/utils/searchTextOverlay";
import { registerTerminalLinks } from "@/utils/terminalLinks";
import {
  markSearchSelection,
  renderTextOnlySelection
} from "@/utils/terminalSelection";
import { stripPrompt } from "@/utils/stripPrompt";

export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  mounted: boolean;
  sourceSessionId: string;
};

// 搜索高亮装饰（常量，不随渲染变化）
const searchDecorations = {
  matchBackground: "#f2c94c",
  matchOverviewRuler: "#f2c94c",
  activeMatchBackground: "#ef4444",
  activeMatchColorOverviewRuler: "#ef4444"
};

export function useTerminals(
  onError: (reason: unknown) => void,
  onSavePassword?: (
    sourceSessionId: string,
    encrypted: string
  ) => void
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
  const [searchOpen, setSearchOpen] =
    useState(false);
  const [searchError, setSearchError] =
    useState("");
  const [
    searchCaseSensitive,
    setSearchCaseSensitive
  ] = useState(false);
  const [searchRegex, setSearchRegex] =
    useState(true);
  const [searchResults, setSearchResults] =
    useState<
      Record<
        string,
        { index: number; count: number }
      >
    >({});

  const openedRef = useRef(opened);
  const activeIdRef = useRef(activeId);
  const disconnectedRef = useRef(disconnected);
  const searchResultsRef = useRef(searchResults);
  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    disconnectedRef.current = disconnected;
  }, [disconnected]);
  useEffect(() => {
    searchResultsRef.current = searchResults;
  }, [searchResults]);

  const unlisteners = useRef<UnlistenFn[]>([]);
  const resizeObserver = useRef<
    ResizeObserver | undefined
  >(undefined);
  const documentShortcutHandler = useRef<
    ((event: KeyboardEvent) => void) | undefined
  >(undefined);
  const terminalHostRef =
    useRef<HTMLElement | null>(null);
  const contextMenu = useRef<
    HTMLDivElement | undefined
  >(undefined);
  const menuCopyItem = useRef<
    HTMLDivElement | undefined
  >(undefined);
  const menuTerminal = useRef<
    Terminal | undefined
  >(undefined);

  const setTerminalHost = useCallback(
    (el: HTMLElement | null) => {
      terminalHostRef.current = el;
    },
    []
  );

  const active = opened.find(
    s => s.id === activeId
  );
  const searchResult = searchResults[
    activeId
  ] ?? { index: -1, count: 0 };

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

  // ---- 2. Context menu ----
  const hideContextMenu = useCallback(() => {
    if (contextMenu.current)
      contextMenu.current.style.display = "none";
  }, []);

  // ---- 3. Search helpers ----
  const clearSearchMarks = useCallback(
    (session: OpenSession) => {
      session.search.clearDecorations();
      clearSearchTextOverlays();
      session.terminal.clearSelection();
      session.terminal.refresh(
        0,
        session.terminal.rows - 1
      );
      sweepStaleDecorations(session.terminal);
    },
    []
  );

  const openSearch = useCallback(() => {
    setSearchError("");
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchError("");
    const session = openedRef.current.find(
      s => s.id === activeIdRef.current
    );
    if (session) clearSearchMarks(session);
  }, [clearSearchMarks]);

  const clearSearchCache = useCallback(() => {
    const session = openedRef.current.find(
      s => s.id === activeIdRef.current
    );
    if (!session) return;
    clearSearchMarks(session);
    setSearchResults(prev => {
      const next = {
        ...prev,
        [session.id]: { index: -1, count: 0 }
      };
      searchResultsRef.current = next;
      return next;
    });
  }, [clearSearchMarks]);

  const toggleCaseSensitive = useCallback(() => {
    setSearchCaseSensitive(prev => !prev);
    clearSearchCache();
  }, [clearSearchCache]);

  const toggleRegex = useCallback(() => {
    setSearchRegex(prev => !prev);
    clearSearchCache();
  }, [clearSearchCache]);

  const search = useCallback(
    (
      query: string,
      direction:
        "next" | "prev" | "input" = "next"
    ) => {
      const current = openedRef.current.find(
        s => s.id === activeIdRef.current
      );
      if (!current) return;
      if (!query) {
        clearSearchMarks(current);
        setSearchResults(prev => {
          const next = {
            ...prev,
            [current.id]: { index: -1, count: 0 }
          };
          searchResultsRef.current = next;
          return next;
        });
        setSearchError("");
        return;
      }
      if (searchRegex) {
        try {
          new RegExp(query);
          setSearchError("");
        } catch {
          setSearchError("正则无效");
          return;
        }
      } else {
        setSearchError("");
      }
      const options = {
        regex: searchRegex,
        caseSensitive: searchCaseSensitive,
        decorations: searchDecorations
      };
      markSearchSelection(current.terminal);
      if (direction === "input")
        current.search.findNext(query, {
          ...options,
          incremental: true
        });
      else if (direction === "prev")
        current.search.findPrevious(
          query,
          options
        );
      else
        current.search.findNext(query, options);
      paintSearchTextOverlays(
        current.terminal,
        query,
        searchRegex,
        searchCaseSensitive
      );
      sweepStaleDecorations(current.terminal);
    },
    [
      searchRegex,
      searchCaseSensitive,
      clearSearchMarks
    ]
  );

  // ---- 4. Context menu (uses openSearch) ----
  const ensureContextMenu =
    useCallback((): HTMLDivElement => {
      if (contextMenu.current)
        return contextMenu.current;
      const menu = document.createElement("div");
      menu.className = "terminal-context-menu";
      const copyItem =
        document.createElement("div");
      copyItem.className = "menu-item";
      copyItem.textContent = "复制 CTRL+C";
      copyItem.addEventListener("click", () => {
        if (
          !copyItem.classList.contains("disabled")
        )
          navigator.clipboard
            .writeText(
              menuTerminal.current?.getSelection() ??
                ""
            )
            .catch(onError);
        hideContextMenu();
        menuTerminal.current?.focus();
      });
      menuCopyItem.current = copyItem;
      const pasteItem =
        document.createElement("div");
      pasteItem.className = "menu-item";
      pasteItem.textContent = "粘贴 CTRL+V";
      pasteItem.addEventListener("click", () => {
        navigator.clipboard
          .readText()
          .then(text => {
            if (text)
              menuTerminal.current?.paste(text);
          })
          .catch(onError);
        hideContextMenu();
        menuTerminal.current?.focus();
      });
      const findItem =
        document.createElement("div");
      findItem.className = "menu-item";
      findItem.textContent = "查找 CTRL+F";
      findItem.addEventListener("click", () => {
        hideContextMenu();
        openSearch();
      });
      menu.append(copyItem, pasteItem, findItem);
      document.body.append(menu);
      window.addEventListener(
        "mousedown",
        event => {
          if (
            menu &&
            !menu.contains(event.target as Node)
          )
            hideContextMenu();
        }
      );
      window.addEventListener(
        "keydown",
        event => {
          if (
            event.key === "Escape" &&
            menu.style.display === "block"
          ) {
            hideContextMenu();
            menuTerminal.current?.focus();
          }
        },
        true
      );
      contextMenu.current = menu;
      return menu;
    }, [onError, hideContextMenu, openSearch]);

  const showContextMenu = useCallback(
    (event: MouseEvent, terminal: Terminal) => {
      event.preventDefault();
      event.stopPropagation();
      menuTerminal.current = terminal;
      const menu = ensureContextMenu();
      if (menuCopyItem.current)
        menuCopyItem.current.classList.toggle(
          "disabled",
          !terminal.hasSelection() ||
            !terminal.getSelection().trim()
        );
      menu.style.visibility = "hidden";
      menu.style.display = "block";
      const rect = menu.getBoundingClientRect();
      menu.style.left =
        Math.min(
          event.clientX,
          window.innerWidth - rect.width - 4
        ) + "px";
      menu.style.top =
        Math.min(
          event.clientY,
          window.innerHeight - rect.height - 4
        ) + "px";
      menu.style.visibility = "visible";
      terminal.focus();
    },
    [ensureContextMenu]
  );

  // ---- 5. Terminal creation (uses openSearch, showContextMenu) ----
  const createTerminal = useCallback(
    (
      session: SavedSession,
      sourceSessionId: string
    ): OpenSession => {
      const terminal = new Terminal({
        cursorBlink: true,
        allowProposedApi: true,
        fontFamily:
          '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontSize: 14,
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
      searchAddon.onDidChangeResults(event => {
        setSearchResults(prev => {
          const next = {
            ...prev,
            [session.id]: {
              index: event.resultIndex,
              count: event.resultCount
            }
          };
          searchResultsRef.current = next;
          return next;
        });
      });
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
            openSearch();
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
        event => showContextMenu(event, terminal)
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
    [onError, openSearch, showContextMenu]
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
          openSearch();
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
  }, [resize, openSearch]);

  return {
    opened,
    activeId,
    active,
    setTerminalHost,
    disconnected,
    open,
    duplicate,
    activate,
    close,
    passwordRequest,
    submitPassword,
    cancelPassword,
    searchOpen,
    searchError,
    searchResult,
    searchCaseSensitive,
    searchRegex,
    openSearch,
    closeSearch,
    toggleCaseSensitive,
    toggleRegex,
    search
  };
}
