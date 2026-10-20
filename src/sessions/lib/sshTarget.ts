/**
 * 前端侧的 SSH 连接目标：把「会话 + 跳板引用链 + 全局私钥设置」拼成
 * 后端 SFTP / AI 命令要的连接参数。
 *
 * 终端会话走系统 `ssh.exe`，跳板与私钥由 `-J` / `-i` 参数搞定；SFTP 与
 * AI 命令走内置 `ssh2`，必须由前端把每一跳的地址、密码和私钥路径一起
 * 传过去。这里就是两条连接路径的收口点：
 *
 * - 跳板链顺序由 `resolveJumpPath` 统一解析（与 `-J` 规格同源）；
 * - 密码按需解密（会话里存的是 DPAPI 密文，OpenSession 里是明文，
 *   `resolvePassword` 两种都能处理）；
 * - 私钥路径取全局设置（与终端的 `-i` 一致）。
 */
import { resolveJumpPath } from "@/sessions/lib/jumpHost";
import type { SavedSession } from "@/sessions/lib/session";
import { loadSettings } from "@/settings/lib/settings";
import { resolvePassword } from "@/sftp/lib/sftpUtils";

/** 一跳跳板机的连接参数（离客户端最近的一跳在前）。 */
export type JumpHop = {
  host: string;
  port: number;
  username: string;
  /** 明文密码；没保存密码时为 null（交给私钥 / agent）。 */
  password: string | null;
};

/** SFTP 与 AI exec 共用的连接目标。字段名与后端 serde 的 camelCase 对齐。 */
export type SshTarget = {
  host: string;
  port: number;
  username: string;
  /** 明文密码；没保存密码时为 null。 */
  password: string | null;
  /** 全局默认私钥路径；空串表示不指定。 */
  keyPath: string;
  /** 跳板链；空数组表示直连。 */
  jump: JumpHop[];
};

/** 把会话里存的密码还原成明文（默认实现，测试可注入替身）。 */
export type SecretResolver = (
  stored: string
) => Promise<string>;

/** 构造连接目标的可选参数。 */
export type BuildSshTargetOptions = {
  /**
   * 私钥路径。缺省读设置；终端会话在启动时把已加载的 `sshKeyPath`
   * 传进来，避免同一次操作读到两份不同来源的设置。
   */
  keyPath?: string;
  /** 密码解密函数；缺省走 DPAPI 的 `decrypt`。 */
  secret?: SecretResolver;
  /**
   * 目标会话的**明文**密码。终端启动时密码已经在内存里解密过，
   * 直接传入可避免再走一次 DPAPI，也避免明文被 `looksEncrypted`
   * 误判成密文。缺省时从 `from.password` 解析。
   */
  password?: string | null;
};

/**
 * 构造一条 SFTP / AI 可用的连接目标。
 *
 * 跳板链的密码逐跳解密；任何一跳没有保存密码时传 null，由后端依次尝试
 * 私钥、agent —— 与终端 `ssh -J` 的认证方式保持一致。
 *
 * @param from 发起连接的会话（密码可以是密文或明文）
 * @param sessions 全部会话，用于解析跳板引用链
 * @param options 私钥路径与解密函数的覆盖项（测试 / 终端启动时用）
 */
export async function buildSshTarget(
  from: SavedSession,
  sessions: SavedSession[],
  options: BuildSshTargetOptions = {}
): Promise<SshTarget> {
  const secret =
    options.secret ?? resolvePassword;
  const keyPath = (
    options.keyPath ?? loadSettings().sshKeyPath
  ).trim();
  const hops =
    resolveJumpPath(from, sessions) ?? [];
  const jump = await Promise.all(
    hops.map(async hop => ({
      host: hop.host.trim(),
      port: hop.port || 22,
      username: hop.username.trim(),
      password: hop.password
        ? await secret(hop.password)
        : null
    }))
  );
  return {
    host: from.host.trim(),
    port: from.port || 22,
    username: from.username.trim(),
    password:
      options.password !== undefined
        ? options.password
        : from.password
          ? await secret(from.password)
          : null,
    keyPath,
    jump
  };
}

/**
 * 取一条已打开会话的连接目标。
 *
 * 目标在会话启动时解析好并挂在 OpenSession 上；取不到说明会话还在
 * 启动中（或不是 SSH 会话），给出可读错误而不是发一条空主机请求。
 */
export function execTargetOf(
  session:
    { execTarget?: SshTarget } | null | undefined
): SshTarget {
  if (!session?.execTarget) {
    throw new Error(
      "会话连接信息尚未就绪，请等终端提示符出现后重试"
    );
  }
  return session.execTarget;
}
