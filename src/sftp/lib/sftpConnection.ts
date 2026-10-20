import type { SavedSession } from "@/sessions/lib/session";
import {
  buildSshTarget,
  type SshTarget
} from "@/sessions/lib/sshTarget";
import { loadSessions } from "@/sessions/lib/useSessions";

/**
 * 远程连接参数：密码解成明文（后端只在内存里用，不写日志/落盘），
 * 并带上跳板链与全局私钥路径。
 */
export type RemoteConnection = SshTarget;

/**
 * 组装远程操作需要的连接参数。
 *
 * 所有 `sftp_*` 命令的 job 都要带这份参数。提成模块函数而不是 hook 里的
 * useCallback：它只依赖 session 与本地数据，没有自己的状态。
 *
 * 跳板会话在独立 SFTP 窗口里同样可用：窗口启动时 `initStorage()` 已经把
 * 全部会话读进内存，这里按引用链现场解析即可（与主窗口同一套规则）。
 */
export async function buildRemoteConnection(
  session: SavedSession | null
): Promise<RemoteConnection> {
  if (!session) {
    throw new Error("当前没有活动的 SFTP 会话");
  }
  return buildSshTarget(session, loadSessions());
}
