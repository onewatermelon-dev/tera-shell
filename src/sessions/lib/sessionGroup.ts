import type { SavedSession } from "@/sessions/lib/session";

/**
 * 会话分组的类型、颜色色板与聚合纯函数。
 *
 * 分组元数据（名称、颜色、折叠态）与会话本身分开存放：
 * 会话只存一个 `groupId` 引用，重命名分组不必改写每条会话。
 */

/** 颜色标记的取值。空串表示不标记（走中性色）。 */
export type ColorTag =
  | ""
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "purple"
  | "pink"
  | "gray";

/**
 * 可选颜色（会话与分组共用一套）。
 *
 * 色值取自 HeroUI 主题色板，深浅两套主题下都能看清；
 * 侧栏色条与图标底色都用它。
 */
export const COLOR_TAGS: {
  value: ColorTag;
  /** CSS 颜色，直接写进行内 style */
  hex: string;
}[] = [
  { value: "", hex: "transparent" },
  { value: "red", hex: "#f31260" },
  { value: "orange", hex: "#f5a524" },
  { value: "yellow", hex: "#e3c800" },
  { value: "green", hex: "#17c964" },
  { value: "cyan", hex: "#00b7c3" },
  { value: "blue", hex: "#3b82f6" },
  { value: "purple", hex: "#8b5cf6" },
  { value: "pink", hex: "#ec4899" },
  { value: "gray", hex: "#8a8f99" }
];

/** 取颜色对应的 CSS 色值；未登记的取值一律当「无颜色」处理。 */
export function colorHex(
  tag: ColorTag | undefined
): string {
  if (!tag) return "transparent";
  return (
    COLOR_TAGS.find(item => item.value === tag)
      ?.hex ?? "transparent"
  );
}

/** 把任意输入夹成合法的 ColorTag（脏数据 / 旧版本残留的安全网）。 */
export function normalizeColorTag(
  value: unknown
): ColorTag {
  return COLOR_TAGS.some(
    item => item.value === value
  )
    ? (value as ColorTag)
    : "";
}

/** 一个会话分组。 */
export type SessionGroup = {
  id: string;
  name: string;
  /** 分组色：显示在折叠标题行的小色点上。 */
  color: ColorTag;
  /** 折叠态：true 时只显示标题行，不渲染组内会话。 */
  collapsed: boolean;
};

/** 侧栏渲染用的分组视图：分组本身 + 组内会话。 */
export type SessionGroupView = {
  /** 分组 id；未分组一节的 id 为空串。 */
  id: string;
  name: string;
  color: ColorTag;
  collapsed: boolean;
  sessions: SavedSession[];
  /** 未分组一节没有可折叠的分组元数据，标题行的箭头不显示。 */
  builtin: boolean;
};

/** 未分组一节的 id。空分组不可用作真实 id（crypto.randomUUID 不会是空串）。 */
export const UNGROUPED_ID = "";

/**
 * 未分组一节在 DOM 上的标记值。
 *
 * 不能直接把空串写进 `data-group-section` —— React 会**整个省略**空串属性，
 * 拖拽落点就找不到这个节了。也不能用 "ungrouped" 这种字面量充当分组 id：
 * 拖进去等于凭空建了个真分组。所以用独立常量做标记，落点处再翻回
 * UNGROUPED_ID。
 */
export const UNGROUPED_ATTR = "_ungrouped";

/** 把 DOM 上的分组标记翻成分组 id。 */
export function attrToGroupId(
  attr: string | null
): string {
  return attr === UNGROUPED_ATTR
    ? UNGROUPED_ID
    : (attr ?? "");
}

/** 新建分组的初始值（名称留空由用户填）。 */
export function emptyGroup(): SessionGroup {
  return {
    id: crypto.randomUUID(),
    name: "",
    color: "",
    collapsed: false
  };
}

/** 把任意输入读成分组数组；结构不对就退回空数组。 */
export function parseGroups(
  raw: string | null
): SessionGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => ({
      id: String(item?.id ?? ""),
      name: String(item?.name ?? ""),
      color: normalizeColorTag(item?.color),
      collapsed: item?.collapsed === true
    }));
  } catch (error) {
    console.warn(
      "[groups] 分组数据解析失败，按空处理",
      error
    );
    return [];
  }
}

/**
 * 把会话按分组聚合成侧栏要渲染的若干节。
 *
 * 三条规则：
 * 1. 分组顺序 = `groups` 里的顺序（用户拖出来的次序），组内保持会话数组原序；
 * 2. 未分组的会话（无 groupId，或指向已删除的分组）统一并入末尾的「未分组」节 ——
 *    删分组不该让会话凭空消失；
 * 3. 空分组（组内 0 条会话）**仍然渲染**：它是用户刚建好、还没往里放东西的位置。
 *
 * 纯函数：不碰存储、不读全局状态，方便直接写单测。
 */
export function groupSessions(
  sessions: SavedSession[],
  groups: SessionGroup[]
): SessionGroupView[] {
  // 先按分组 id 攒好桶，最后再按 groups 顺序拼装 ——
  // 直接往 views[i] 里塞会踩 noUncheckedIndexedAccess（索引访问可能 undefined），
  // 而这里的下标本来就是自己算出来的，判空只是噪音
  const buckets = new Map<string, SavedSession[]>(
    groups.map(group => [group.id, []])
  );
  const loose: SavedSession[] = [];

  for (const session of sessions) {
    const bucket = session.groupId
      ? buckets.get(session.groupId)
      : undefined;
    if (bucket) bucket.push(session);
    else loose.push(session);
  }

  const views: SessionGroupView[] = groups.map(
    group => ({
      id: group.id,
      name: group.name.trim() || "—",
      color: group.color,
      collapsed: group.collapsed,
      sessions: buckets.get(group.id) ?? [],
      builtin: false
    })
  );

  if (loose.length) {
    views.push({
      id: UNGROUPED_ID,
      name: "",
      color: "",
      collapsed: false,
      sessions: loose,
      builtin: true
    });
  }
  return views;
}
