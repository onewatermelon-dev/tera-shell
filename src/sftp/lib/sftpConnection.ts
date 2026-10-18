import type { SavedSession } from "@/sessions/lib/session";
import { resolvePassword } from "@/sftp/lib/sftpUtils";

/** 远程连接参数：密码解成明文（后端只在内存里用，不写日志/落盘）。 */
export type RemoteConnection = {
  host: string;
  port: number;
  username: string;
  password: string | null;
};

/**
 * 组装远程操作需要的连接参数（含解密后的密码）。
 *
 * 所有 `sftp_*` 命令的 job 都要带这份参数。提成模块函数而不是 hook 里的
 * useCallback：它只依赖 session、没有自己的状态，调用方把 session 传进来即可。
 */
export async function buildRemoteConnection(
  session: SavedSession | null
): Promise<RemoteConnection> {
  if (!session) {
    throw new Error("当前没有活动的 SFTP 会话");
  }
  return {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password
      ? await resolvePassword(session.password)
      : null
  };
}
