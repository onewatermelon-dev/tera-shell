import type { SavedSession } from "@/sessions/lib/session";

/**
 * 跳板链解析：把会话的 `jumpHostId` 引用链摊成 ssh `-J` 的规格串。
 *
 * 链式多跳走的是「中间会话自己也配了跳板」这条天然路径 —— 比在单个
 * 会话上存数组干净：跳板自己的跳板只有一处定义，改一处全链生效。
 *
 * 返回 undefined 表示「不走跳板」，含两种安全降级（调用方按直连处理）：
 * - 引用的跳板会话已被删除（改配置不该把连接堵死；不走跳板通常要么
 *   直接连不上（目标在内网），要么仍受 TOFU 主机密钥保护）
 * - 成环（含自己跳自己）—— 拼出来的 `-J` 是死循环，ssh 必拒
 * 两种情况都 console.warn，排查有迹可循。
 */

/** 会话 → 单跳规格 `[user@]host[:port]`；非 ssh 或空主机返回 null。 */
function hopSpec(
  session: SavedSession
): string | null {
  if (session.kind !== "ssh") return null;
  const host = session.host.trim();
  if (!host) return null;
  const username = session.username.trim();
  const target = username
    ? `${username}@${host}`
    : host;
  // 22 是 ssh 默认端口，不写进规格：-J 的默认端口就是 22
  return session.port && session.port !== 22
    ? `${target}:${session.port}`
    : target;
}

/**
 * 解析 from 的完整跳板链，返回**会话对象**（离客户端最近的一跳在前）。
 *
 * 例：A 跳 B、B 跳 C → `[C, B]`：客户端先连 C，再经 C 连 B，最后到 A。
 * 终端侧只要 `-J` 规格，SFTP / AI 侧还需要每一跳的地址与密码，所以
 * 把「链解析」和「规格拼装」拆开 —— 两边共用同一套防环 / 缺失降级规则。
 *
 * 不走跳板 / 解析失败返回 undefined。
 *
 * @param from 发起连接的会话（读它自己的 jumpHostId 起步）
 * @param sessions 全部已保存会话（按 id 查每一跳）
 */
export function resolveJumpPath(
  from: SavedSession,
  sessions: SavedSession[]
): SavedSession[] | undefined {
  if (!from.jumpHostId) return undefined;
  const byId = new Map(
    sessions.map(session => [session.id, session])
  );
  // 防环：连 from 自己也算「已访问」—— 自己跳自己的环在这里就被截住
  const visited = new Set<string>([from.id]);
  const hops: SavedSession[] = [];
  let nextId: string | undefined =
    from.jumpHostId;
  while (nextId) {
    if (visited.has(nextId)) {
      console.warn(
        "[jump-host] 跳板链成环，本次连接不走跳板",
        from.id,
        nextId
      );
      return undefined;
    }
    visited.add(nextId);
    const hop = byId.get(nextId);
    if (!hop) {
      console.warn(
        "[jump-host] 跳板会话已删除，本次连接不走跳板",
        nextId
      );
      return undefined;
    }
    if (!hopSpec(hop)) {
      console.warn(
        "[jump-host] 跳板会话不是可用的 ssh 连接，本次连接不走跳板",
        hop.id
      );
      return undefined;
    }
    hops.push(hop);
    nextId = hop.jumpHostId;
  }
  // 引用链是从目标往外追的（A 跳 B、B 跳 C ⇒ 物理路径 客户端→C→B→A），
  // 而连接要求离客户端最近的跳板在前 —— 收集完反转
  return hops.length ? hops.reverse() : undefined;
}

/**
 * 解析 from 的完整跳板链，返回逗号分隔的 `-J` 规格（首跳在前）。
 *
 * 例：A 跳 B、B 跳 C → `"userC@hostC,userB@hostB"`，ssh 先连 C 再连 B，
 * 最后落到 A 的目标。不走跳板 / 解析失败返回 undefined。
 *
 * @param from 发起连接的会话（读它自己的 jumpHostId 起步）
 * @param sessions 全部已保存会话（按 id 查每一跳）
 */
export function resolveJumpChain(
  from: SavedSession,
  sessions: SavedSession[]
): string | undefined {
  const path = resolveJumpPath(from, sessions);
  if (!path) return undefined;
  return (
    path
      .map(hop => hopSpec(hop))
      .filter(
        (spec): spec is string => spec !== null
      )
      .join(",") || undefined
  );
}
