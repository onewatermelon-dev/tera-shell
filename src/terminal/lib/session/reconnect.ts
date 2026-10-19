/**
 * 自动重连策略。
 *
 * 断线后按退避重试有限次，全失败就交回给用户手动重连 —— 无限重试
 * 会把远端 fail2ban 喂饱、也可能把日志刷爆。
 */

/** 一次断开最多自动重连几次。 */
export const MAX_RECONNECT_ATTEMPTS = 5;

/** 首次重连的等待时长（毫秒），之后逐次翻倍。 */
export const RECONNECT_BASE_DELAY = 1000;

/** 单次等待上限（毫秒）：退避再大也不超过它，免得看起来像卡死。 */
export const RECONNECT_MAX_DELAY = 15000;

/**
 * ssh 的连接错误退出码。
 *
 * man ssh：出错时 ssh 固定以 255 退出 —— 网络断开、认证失败、远端拒绝
 * 都落在它上面。而用户敲 exit 拿到的是远端 shell 的退出码（通常 0），
 * 两者天然区分开，这就是「该不该自动重连」唯一可靠的信号。
 */
export const SSH_ERROR_EXIT_CODE = 255;

/**
 * 第 attempt 次重连前的等待时长（attempt 从 1 开始）。
 *
 * 1s → 2s → 4s → 8s → 15s（封顶），累计约 30 秒。
 * 非正数按第一次处理，容错不抛错。
 */
export function reconnectDelay(
  attempt: number
): number {
  const index = Math.max(
    0,
    Math.floor(attempt) - 1
  );
  return Math.min(
    RECONNECT_BASE_DELAY * 2 ** index,
    RECONNECT_MAX_DELAY
  );
}

/**
 * 这次断开是否值得自动重连。
 *
 * 只认「SSH 会话 + 连接错误退出码」：本地终端的进程退出＝用户自己敲了
 * exit 或关了窗口，ssh 正常退出同理，都不该被强行拉起来。退出码缺失
 * （极少数收尾路径）时保守起见也不重连，交给手动入口。
 */
export function shouldAutoReconnect(
  kind: string,
  code: number | null | undefined
): boolean {
  return (
    kind === "ssh" && code === SSH_ERROR_EXIT_CODE
  );
}

/**
 * ssh 在主机指纹与 known_hosts 不一致时的报错特征（两种措辞都收）：
 * - 「REMOTE HOST IDENTIFICATION HAS CHANGED!」= 指纹变更（潜在中间人攻击）
 * - 「Host key verification failed」= strict 模式下新主机不在 known_hosts
 *
 * 这两种情况 ssh 同样以 255 退出，与网络断开无从区分 —— 但重连
 * 五次的结果必然是同样报错，纯刷屏。靠这段特征文本把它们摘出来。
 */
const HOST_KEY_ERROR_MARKERS = [
  "REMOTE HOST IDENTIFICATION HAS CHANGED",
  "Host key verification failed"
] as const;

/**
 * 这段 ssh 输出是否为密钥校验失败（指纹变更或 strict 下的未知主机）。
 *
 * 输入应为退出前的**尾部输出**（调用方负责累积）；大小写敏感以
 * ssh 实际输出为准，不做宽松匹配 —— 误判的代价是把真正的断网
 * 当成指纹问题不重连。
 */
export function isHostKeyError(
  output: string
): boolean {
  return HOST_KEY_ERROR_MARKERS.some(marker =>
    output.includes(marker)
  );
}
