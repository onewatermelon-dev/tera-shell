import {
  useCallback,
  useMemo,
  useRef,
  useState
} from "react";
import {
  clearSearchTextOverlays,
  paintSearchTextOverlays,
  sweepStaleDecorations
} from "@/features/terminal/searchTextOverlay";
import { markSearchSelection } from "@/features/terminal/terminalSelection";
import type { OpenSession } from "@/features/terminal/terminalTypes";

// 搜索高亮装饰（常量，不随渲染变化）
const searchDecorations = {
  matchBackground: "#f2c94c",
  matchOverviewRuler: "#f2c94c",
  activeMatchBackground: "#ef4444",
  activeMatchColorOverviewRuler: "#ef4444"
};

/** 单个会话的搜索进度：当前命中序号与总数。 */
export type SearchProgress = {
  index: number;
  count: number;
};

/**
 * 终端查找能力：搜索框开关、匹配项高亮与结果计数。
 *
 * 结果按会话 id 分别记录，切换标签时各自保留自己的进度。
 * 两个 ref 用来在非事件回调（如 xterm 的结果回调）里读到最新的会话列表。
 */
export function useTerminalSearch(
  openedRef: { current: OpenSession[] },
  activeIdRef: { current: string }
) {
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
  const [results, setResults] = useState<
    Record<string, SearchProgress>
  >({});
  // 供回调里同步读取最新结果（setState 之后立刻读 state 会拿到旧值）
  const resultsRef = useRef(results);

  /** 找到当前激活的会话。 */
  const currentSession = useCallback(
    () =>
      openedRef.current.find(
        session =>
          session.id === activeIdRef.current
      ),
    [openedRef, activeIdRef]
  );

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

  /** 把某个会话的结果清零（切换搜索模式、清空关键字时用）。 */
  function resetProgress(sessionId: string) {
    setResults(previous => {
      const next = {
        ...previous,
        [sessionId]: { index: -1, count: 0 }
      };
      resultsRef.current = next;
      return next;
    });
  }

  const openSearch = useCallback(() => {
    setSearchError("");
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchError("");
    const session = currentSession();
    if (session) clearSearchMarks(session);
  }, [clearSearchMarks, currentSession]);

  const clearSearchCache = useCallback(() => {
    const session = currentSession();
    if (!session) return;
    clearSearchMarks(session);
    resetProgress(session.id);
  }, [clearSearchMarks, currentSession]);

  const toggleCaseSensitive = useCallback(() => {
    setSearchCaseSensitive(previous => !previous);
    clearSearchCache();
  }, [clearSearchCache]);

  const toggleRegex = useCallback(() => {
    setSearchRegex(previous => !previous);
    clearSearchCache();
  }, [clearSearchCache]);

  const search = useCallback(
    (
      query: string,
      direction:
        "next" | "prev" | "input" = "next"
    ) => {
      const current = currentSession();
      if (!current) return;
      if (!query) {
        clearSearchMarks(current);
        resetProgress(current.id);
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
      if (direction === "input") {
        current.search.findNext(query, {
          ...options,
          incremental: true
        });
      } else if (direction === "prev") {
        current.search.findPrevious(
          query,
          options
        );
      } else {
        current.search.findNext(query, options);
      }
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
      clearSearchMarks,
      currentSession
    ]
  );

  /** xterm 的 SearchAddon 回调：记录某个会话的命中结果。 */
  const reportResults = useCallback(
    (
      sessionId: string,
      index: number,
      count: number
    ) => {
      setResults(previous => {
        const next = {
          ...previous,
          [sessionId]: { index, count }
        };
        resultsRef.current = next;
        return next;
      });
    },
    []
  );

  return useMemo(
    () => ({
      searchOpen,
      searchError,
      results,
      searchCaseSensitive,
      searchRegex,
      openSearch,
      closeSearch,
      toggleCaseSensitive,
      toggleRegex,
      search,
      reportResults
    }),
    [
      searchOpen,
      searchError,
      results,
      searchCaseSensitive,
      searchRegex,
      openSearch,
      closeSearch,
      toggleCaseSensitive,
      toggleRegex,
      search,
      reportResults
    ]
  );
}
