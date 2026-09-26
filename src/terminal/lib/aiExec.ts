import { invoke } from "@tauri-apps/api/core";

/** 一次命令执行的产物。 */
export type AiExecResult = {
  stdout: string;
  stderr: string;
  /** 退出码；通道异常拿不到时为 -1。 */
  exitCode: number;
};

/**
 * 在 SSH 会话对应的远端执行一条命令（AI 面板专用）。
 *
 * 走后端独立的 ssh2 exec 通道：输出不经过终端 PTY，不会污染用户正在
 * 敲字的会话，也不进服务器的命令历史。密码需先经后端 `decrypt` 解开、
 * 明文传入（与 SFTP 流程一致），只在内存中使用。
 */
export function aiRunCommand(
  target: {
    host: string;
    port?: number;
    username?: string;
    password?: string;
  },
  command: string
): Promise<AiExecResult> {
  return invoke("ai_run_command", {
    target: { ...target, command }
  });
}
