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
 *
 * `execId` 是「停止」的把手：带上它，`cancelAiExec` 才能把这条命令
 * 从后端读循环里掐掉（关 exec 通道）。不带的命令取消不了。
 */
export function aiRunCommand(
  target: {
    host: string;
    port?: number;
    username?: string;
    password?: string;
  },
  command: string,
  /** 喂给命令 stdin 的内容（走数据流分包，不受命令串 ~16KB 包上限约束） */
  stdin?: string,
  /** 前端生成的执行 id，停止时靠它定位这条命令 */
  execId?: string
): Promise<AiExecResult> {
  return invoke("ai_run_command", {
    target: {
      ...target,
      command,
      stdin: stdin ?? null,
      execId: execId ?? null
    }
  });
}

/**
 * 中断一条进行中的命令（前端「停止」按钮）。
 *
 * 只置后端的取消标志：真正停下来在读循环里（关 exec 通道，sshd 随即
 * 给命令进程组发 SIGHUP）。返回是否命中（未命中 = 命令已结束或 id 不对）。
 */
export function cancelAiExec(
  execId: string
): Promise<boolean> {
  return invoke("ai_exec_cancel", { execId });
}
