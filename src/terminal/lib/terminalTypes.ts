import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/sessions/lib/session";
import type { CompletionController } from "@/terminal/lib/commandCompletion";

/** 已打开的终端会话：会话定义 + 运行时实例与挂载状态。 */
export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** 命令补全控制器（PSReadLine 内联预测风格，见 commandCompletion） */
  completion: CompletionController;
  element: HTMLDivElement;
  /** 是否已经 open() 到 DOM（xterm 只允许打开一次） */
  mounted: boolean;
  /** 复制会话时指向被复制的那个会话 id */
  sourceSessionId: string;
};
