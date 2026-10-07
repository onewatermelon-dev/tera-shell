import type { SavedSession } from "@/sessions/lib/session";
import { localSession } from "@/sessions/lib/session";
import {
  normalizeColorTag,
  type SessionGroup
} from "@/sessions/lib/sessionGroup";

/**
 * 会话导入 / 导出的格式与纯函数。
 *
 * 导出文件长这样：
 * ```json
 * {
 *   "format": "tera-shell.sessions",
 *   "version": 1,
 *   "exportedAt": "2026-10-07T...",
 *   "groups":   [{ "id": "g1", "name": "生产", "color": "red" }],
 *   "sessions": [{ "name": "web-01", "kind": "ssh", "host": "10.0.0.1",
 *                  "port": 22, "username": "ops", "groupId": "g1" }]
 * }
 * ```
 *
 * ## 三条硬规则
 *
 * **密码永不导出。** 密码是 DPAPI 密文，绑定当前 Windows 用户 —— 换机器
 * 本来也解不开，写进文件除了泄露没有别的用处。导入后用户自己再填一次。
 *
 * **id 不导出，导入时重新生成。** 否则同一个文件导入两次就会产生重复 id：
 * React key 撞车、groupId 引用错乱。文件里的 `id` 只作为**分组引用键**
 * 参与关联，落地时一律换成新 id —— 唯一的例外是**同名分组合并**：导入的
 * 分组若与现有分组同名，会话直接挂到那个现有分组上（见 parseImportPayload）。
 *
 * **已有的不导入。** 连接目标（kind + host + port + username）相同的会话
 * 整条跳过，同名分组并入现有分组。导入只负责补齐缺口，不制造重复。
 */

/** 文件格式标识。换格式时用它区分，别只靠扩展名。 */
export const EXPORT_FORMAT =
  "tera-shell.sessions";

/** 当前格式版本。导入时遇到更高版本要明确报错而不是硬解。 */
export const EXPORT_VERSION = 1;

/**
 * 导出文件里的分组。
 *
 * `id` **要保留** —— 它是会话 `groupId` 的引用键，两边靠它关联。
 * 落地时（parseImportPayload）会换成新 id，所以对外泄露/复用的风险为零。
 */
export type TransferGroup = SessionGroup;

/** 导出文件里的会话：没有自己的 id、没有密码，groupId 指向文件内的分组 id。 */
export type TransferSession = Omit<
  SavedSession,
  "id" | "password"
>;

export type ExportPayload = {
  format: string;
  version: number;
  exportedAt: string;
  groups: TransferGroup[];
  sessions: TransferSession[];
};

/** 导入结果：id 已重新生成、重复已剔除、分组引用已重映射，可直接并入现有数据。 */
export type ImportPreview = {
  /** 新分组（id 已生成）。同名分组已合并、因跳过而变空的会被剔除。 */
  groups: SessionGroup[];
  /** 新会话（id 已生成，groupId 指向新分组或被合并到的现有分组）。 */
  sessions: SavedSession[];
  /**
   * 因为「已存在同一台机器的同一账号」而被**跳过**的会话数 ——
   * 它们不在这份结果的 `sessions` 里。
   */
  skipped: number;
  /**
   * 并入现有分组、不新建的分组数。与文件内分组总数相减即真正新建的数量。
   */
  mergedGroups: number;
};

/**
 * 解析结果。用 `ok` 做判别式联合，调用方 `if (!result.ok)` 就能把类型
 * 收窄干净 —— 否则两边字段名不重叠，TS 无法判断到底有没有 `error`。
 */
export type ImportResult =
  | ({ ok: true } & ImportPreview)
  | { ok: false; error: string };

/**
 * 生成导出载荷。
 *
 * 跳过 `local`：本机终端是代码里的常量（id 恒为 `local`），从不写进
 * 存储文件 —— 把它导出去，导入端要么造出第二个假的本机终端，要么与
 * 自带的那个重复。
 */
export function buildExportPayload(
  sessions: SavedSession[],
  groups: SessionGroup[]
): ExportPayload {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    groups: groups.map(group => ({
      id: group.id,
      name: group.name,
      color: group.color,
      collapsed: group.collapsed
    })),
    sessions: sessions
      .filter(
        session => session.id !== localSession.id
      )
      .map(session => ({
        name: session.name,
        kind: session.kind,
        host: session.host,
        port: session.port,
        username: session.username,
        color: session.color,
        // groupId 依赖分组顺序，重映射在 parseImportPayload 里做
        groupId: session.groupId
      }))
  };
}

/** 生成导出文件内容（格式化过的 JSON，便于人工查看与版本管理）。 */
export function serializeExport(
  sessions: SavedSession[],
  groups: SessionGroup[]
): string {
  return JSON.stringify(
    buildExportPayload(sessions, groups),
    null,
    2
  );
}

/** 读出载荷里的分组数组；不是数组就当没有分组。 */
function readGroups(
  raw: unknown
): Record<string, unknown>[] {
  const groups = (raw as { groups?: unknown })
    ?.groups;
  return Array.isArray(groups) ? groups : [];
}

/** 读出载荷里的会话数组；不是数组就当没有会话。 */
function readSessions(
  raw: unknown
): Record<string, unknown>[] {
  const sessions = (raw as { sessions?: unknown })
    ?.sessions;
  return Array.isArray(sessions) ? sessions : [];
}

/**
 * 连接目标的判定键 —— 决定一条导入会话「是不是已经有了」。
 *
 * 只看**怎么连上去**：`kind + host + port + username`。刻意**不含 name /
 * color / groupId**：
 *
 * - 不含 `name`：名字是本地标签。同一台机器在两个人手里可能一个叫
 *   「生产 web-01」、一个叫「web-01」，拿名字判重会把它们当成两条会话
 *   各导一份，侧栏并排出现两个指向同一台机器的条目。
 * - 不含 `color` / `groupId`：纯装饰与归类，同一个连接放不同组、带不同
 *   颜色仍然是同一个连接。
 *
 * 主机名按 DNS 规则**不区分大小写**，`Web-01` 与 `web-01` 视为同一台；
 * 用户名**保持原样** —— Linux 上 `Root` 与 `root` 是两个不同用户，
 * 折叠了就真连不上去。分隔符用空格：主机名与用户名都不含空格，
 * 拼接结果无歧义。
 */
function targetKey(session: {
  kind: string;
  host: string;
  port: number;
  username: string;
}): string {
  return [
    session.kind,
    session.host.trim().toLowerCase(),
    String(session.port),
    session.username.trim()
  ].join(" ");
}

/**
 * 分组的同名判定键。
 *
 * 用「trim 后的小写」而不是原名：分组名是用户手输的，`"生产"` 与
 * `" 生产"`、`"Prod"` 与 `"prod"` 在用户心里显然是同一个分组，
 * 各自长出一个同名分组只会让侧栏出现两行一样的东西。
 *
 * 空名不参与合并（返回空串）—— 文件里多个无名分组无从判断是不是同一个，
 * 硬合并会把不相干的会话塞进同一节。
 */
function groupKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 解析导入文件并生成可直接落地的数据。
 *
 * 防御式解析：文件是用户自己挑的，可能被手改过、可能是别的程序的 JSON。
 * 任何结构不对都返回 `error` 而不是抛异常；单个字段缺失则退到安全默认值
 * （端口 22、名称回落成 `user@host`），不让一条脏数据毁掉整个导入。
 *
 * ## 已有会话直接跳过
 *
 * 导入文件里的会话若与**现有会话**（或文件里更早出现的那条）连接目标相同，
 * **整条不导入**，只记进 `skipped`。导入的意义是补上机器上没有的；
 * 已经有的再导一遍，只会让侧栏多出一行指向同一台机器的条目。
 *
 * 判定口径见 `targetKey`。本机终端（`kind: "local"`，host 恒为
 * `localhost`）必然已在现有会话里，所以手改文件塞进来的 local 条目
 * 也会被跳过 —— 正好符合预期，本机终端只有一个。
 *
 * ## 同名分组合并
 *
 * 导入文件里的分组若与**现有分组**同名，不再新建，而是把会话直接挂到那个
 * 现有分组上（复用其 id）。否则从同事那导一份过来，侧栏会并排出现两个
 * 「生产」，得手动合并。合并时**保留现有分组的名称、颜色与折叠态** ——
 * 那是用户当前的本地设置，导入不该覆盖它。
 *
 * 合并判定用 `groupKey`（trim + 小写），见该函数注释。
 *
 * @param existing 现有会话，用来判定「已存在」而跳过
 * @param existingGroups 现有分组，用来判定同名合并
 */
export function parseImportPayload(
  raw: string,
  existing: SavedSession[],
  existingGroups: SessionGroup[] = []
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "文件不是合法的 JSON，可能选错了文件"
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null
  )
    return {
      ok: false,
      error: "文件内容不是对象"
    };

  const payload = parsed as {
    format?: unknown;
    version?: unknown;
  };
  if (payload.format !== EXPORT_FORMAT)
    return {
      ok: false,
      error: "这不是 Tera Shell 导出的会话文件"
    };
  if (
    typeof payload.version === "number" &&
    payload.version > EXPORT_VERSION
  )
    return {
      ok: false,
      error: `文件版本（${payload.version}）比当前程序（${EXPORT_VERSION}）新，请先升级程序`
    };

  const rawGroups = readGroups(parsed);
  const rawSessions = readSessions(parsed);

  // 现有分组按同名键索引：命中就把会话挂到这个已有分组上，不再新建。
  // 同时把文件内已处理过的分组也记进去，这样**文件内部**自己重名的分组
  // 也会并到一起（否则一次导入就能造出两个同名分组）。
  const existingByKey = new Map<
    string,
    SessionGroup
  >();
  for (const item of existingGroups) {
    const key = groupKey(item.name);
    // 空名分组不进索引：无名分组无从判断是否同一个
    if (key && !existingByKey.has(key))
      existingByKey.set(key, item);
  }

  // 分组：文件内的 id 只做引用键，落地一律换新 id（或复用现有分组的 id）。
  // 旧 id → 落地 id 的映射同时供会话的 groupId 重映射使用。
  const idMap = new Map<string, string>();
  const freshGroups: SessionGroup[] = [];
  let mergedGroups = 0;
  for (const item of rawGroups) {
    const name = String(item.name ?? "");
    const key = groupKey(name);
    const reused = key
      ? existingByKey.get(key)
      : undefined;

    if (reused) {
      // 同名合并：沿用现有分组的 id，不新建、不改它的名称/颜色/折叠态
      mergedGroups += 1;
      if (key) existingByKey.set(key, reused);
      if (item.id != null)
        idMap.set(String(item.id), reused.id);
      continue;
    }

    const fresh = crypto.randomUUID();
    if (item.id != null)
      idMap.set(String(item.id), fresh);
    if (key)
      // 登记进索引：文件里后续出现的同名分组会并到这一个上
      existingByKey.set(key, {
        id: fresh,
        name,
        color: normalizeColorTag(item.color),
        collapsed: false
      });
    freshGroups.push({
      id: fresh,
      name,
      color: normalizeColorTag(item.color),
      collapsed: item.collapsed === true
    });
  }

  // 已占用的连接目标：先用现有会话占位，文件里后面出现的同目标条目
  // 也会撞上 —— 同一个文件里重复两条同样只导一条。
  const taken = new Set(
    existing.map(item => targetKey(item))
  );
  const sessions: SavedSession[] = [];
  // 只有「本次新建的分组」才需要考虑剔除；合并到现有分组的不用管。
  const freshGroupIds = new Set(
    freshGroups.map(item => item.id)
  );
  // 文件里被会话引用到的新分组 / 其中真正收到会话的新分组。
  // 两者相减 = 「文件里有会话、但全部被跳过」的分组，要剔除掉。
  const referenced = new Set<string>();
  const survived = new Set<string>();
  let skipped = 0;
  for (const item of rawSessions) {
    const kind =
      item.kind === "local" ? "local" : "ssh";
    const host = String(item.host ?? "");
    const username = String(item.username ?? "");
    const rawPort = Number(item.port);
    // 端口兜底只对 SSH 生效：local 没有端口概念（恒为 0），
    // 套用 SSH 的「非法→22」会造出一个 key 为 "local localhost 22"
    // 的假条目，与现有的 local 对不上，本机终端就会被重复导入一条。
    const port =
      kind === "local"
        ? 0
        : Number.isFinite(rawPort) && rawPort > 0
          ? rawPort
          : 22;
    const name =
      String(item.name ?? "") ||
      (username ? `${username}@${host}` : host) ||
      "未命名会话";

    // 分组引用重映射：文件里的 groupId 若有对应映射就用它（可能是新分组，
    // 也可能是合并到的现有分组）；认不出则归为未分组。
    // 无论后面跳不跳过，都先记下「这个新分组在文件里被引用过」
    const oldGroupId = String(item.groupId ?? "");
    const groupId = idMap.get(oldGroupId) ?? "";
    if (groupId && freshGroupIds.has(groupId))
      referenced.add(groupId);

    const transferred: TransferSession = {
      name,
      kind,
      host,
      port,
      username,
      color: normalizeColorTag(item.color),
      groupId
    };

    // 已有同一台机器的同一账号 → 整条不导入
    const key = targetKey(transferred);
    if (taken.has(key)) {
      skipped += 1;
      continue;
    }
    taken.add(key);
    if (groupId && freshGroupIds.has(groupId))
      survived.add(groupId);

    sessions.push({
      id: crypto.randomUUID(),
      ...transferred
    });
  }

  // 「文件里有会话、但全部被跳过」的新分组不建：空分组在侧栏仍会渲染成
  // 一行标题，只会让用户困惑「我明明导了，怎么多个空组」。
  //
  // ⚠️ 只删这一种，**不能**简单按「有没有会话指向」来过滤 ——
  // 文件里本来就是空分组（用户刻意建的占位）必须保留，否则导一次丢一个。
  // 合并到现有分组的不在 freshGroups 里，天然不受影响。
  const groups = freshGroups.filter(
    group =>
      !referenced.has(group.id) ||
      survived.has(group.id)
  );

  return {
    ok: true,
    groups,
    sessions,
    skipped,
    mergedGroups
  };
}
