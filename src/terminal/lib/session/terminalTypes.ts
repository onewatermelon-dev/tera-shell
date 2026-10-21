import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/sessions/lib/session";
import type { SshTarget } from "@/sessions/lib/sshTarget";
import type { CompletionController } from "@/terminal/lib/commandCompletion";
import type { ShellIntegration } from "@/terminal/lib/shellIntegration/shellIntegration";

/** 已打开的终端会话：会话定义 + 运行时实例与挂载状态。 */
export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** 命令补全控制器（PSReadLine 内联预测风格，见 commandCompletion） */
  completion: CompletionController;
  /**
   * shell 集成（OSC 133）：远端钩子的命令边界。
   * `available` 为 false 时（没装成钩子）各处自动退回启发式。
   */
  integration: ShellIntegration;
  element: HTMLDivElement;
  /** 是否已经 open() 到 DOM（xterm 只允许打开一次） */
  mounted: boolean;
  /** 复制会话时指向被复制的那个会话 id */
  sourceSessionId: string;
  /**
   * 会话级全局监听的清理函数（挂在 window 上的 paste 等）。
   *
   * `terminal.dispose()` 不会碰这些：注册在 window 上的监听不随 DOM
   * 移除失效，必须在关闭会话时显式摘掉，否则每关一个会话就多一个
   * 永远跑空判断的监听。
   */
  disposeListeners?: () => void;
  /**
   * SFTP / AI 命令用的连接目标（跳板链 + 私钥 + 明文密码，已在启动时
   * 解析好）。终端 PTY 本身走 `-J` / `-i`，不读这份。
   */
  execTarget: SshTarget;
};
