import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/sessions/lib/session";

/** 已打开的终端会话：会话定义 + 运行时实例与挂载状态。 */
export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  /** 是否已经 open() 到 DOM（xterm 只允许打开一次） */
  mounted: boolean;
  /** 复制会话时指向被复制的那个会话 id */
  sourceSessionId: string;
};
