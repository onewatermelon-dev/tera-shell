/**
 * 启动还原：上次开着的标签与分屏。
 *
 * ## 存什么、不存什么
 *
 * 只存「结构性」的东西：哪几个会话开着、怎么分屏、每格显示哪一只。
 * **不存会话内容、不存 PTY** —— 终端滚屏历史属于运行时，还原它既没必要
 * （重启就是要个干净 shell）也不现实（要序列化 xterm 缓冲区）。
 *
 * 标签记的是 `sourceSessionId`（会话库里那条的 id），不是运行时 id：
 * 运行时的 `dup-xxxx` 是临时复制会话，重启后不存在；按来源 id 存，
 * 下次打开就是一个等价的新实例。
 *
 * ## 为什么读的时候要清洗
 *
 * 这个文件是纯文本、可手改，也可能因为崩溃只写了一半。树里引用了不存在
 * 的窗格、比例是 `NaN`、`tabs` 不是数组 —— 任何一条漏过去，启动时会
 * 直接崩在渲染里（用户只会看到白屏）。清洗后最坏是「什么都不还原」，
 * 那至少还能正常打开应用。
 */

import { logWarn } from "@/shared/lib/log";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import {
  MIN_RATIO,
  MAX_RATIO,
  type PaneNode,
  collectLeafIds
} from "@/terminal/lib/pane/paneLayout";
import type { PaneState } from "@/terminal/lib/session/paneGrid";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

/**
 * 结构版本。字段有不兼容变化时递增，旧数据直接丢弃。
 *
 * v2：标签从「来源 id 字符串」改成 `{source, copy?}`，visible 从 id 改成
 * 序号 —— v1 无法区分「原会话」与「拆分出来的副本」，分屏还原不出来。
 */
export const LAYOUT_VERSION = 2;

/**
 * 一个标签的存档。
 *
 * `copy` 是关键：**同一个来源可以同时有好几只**（用户「拆分窗格」或
 * 「复制标签」都会新开一只实例，跑的是同一台机器）。
 * 只记来源 id 是不够的 —— 还原时如果按来源去重，第二只就被当成重复而
 * 丢掉，于是分屏没了（2026-10-25 实测：存档 483 字节含分屏，还原后
 * 变回单窗格）。
 */
export type SavedTab = {
  /** 会话库里的来源 id */
  source: string;
  /** true = 这是同一来源的另一个实例（拆分/复制出来的），还原时要新开一只 */
  copy?: boolean;
};

/** 一个窗格的存档。 */
export type SavedPane = {
  id: string;
  /** 本窗格的标签（按加入顺序） */
  tabs: SavedTab[];
  /** 当前显示的是第几个标签；越界或 -1 时由还原逻辑回落到第一个 */
  visible: number;
};

/** 一份完整的布局存档。 */
export type SavedLayout = {
  version: typeof LAYOUT_VERSION;
  panes: SavedPane[];
  tree: PaneNode;
  activePaneId: string;
};

/**
 * 从运行态抽一份可持久化的布局。
 *
 * `tabIds` 是运行时 id（可能带 `dup-` 前缀），这里换成 `sourceSessionId`；
 * 同一来源出现多次（用户复制了标签）只保留第一次 —— 还原时没法凭空
 * 复活「第二份复制」，保留多个反而会造成重复打开同一个会话。
 */
export function layoutOf(
  opened: OpenSession[],
  panes: PaneState[],
  tree: PaneNode,
  activePaneId: string
): SavedLayout {
  const sourceOf = new Map(
    opened.map(session => [
      session.id,
      session.sourceSessionId
    ])
  );
  const savedPanes = panes.map(pane => {
    const tabs: SavedTab[] = [];
    // 记录每个标签在本格里的序号：visible 记序号而不是 id，
    // 因为副本实例的运行时 id 是临时的（dup-/split-），存下来也没意义
    const indexOf = new Map<string, number>();
    for (const tabId of pane.tabIds) {
      const source = sourceOf.get(tabId);
      if (!source) continue;
      if (indexOf.has(tabId)) continue;
      indexOf.set(tabId, tabs.length);
      // 运行时 id 与来源 id 不同 → 这是同一来源的另一个实例
      const copy = tabId !== source;
      tabs.push(
        copy ? { source, copy: true } : { source }
      );
    }
    return {
      id: pane.id,
      tabs,
      visible: indexOf.get(pane.visibleId) ?? -1
    };
  });
  return {
    version: LAYOUT_VERSION,
    panes: savedPanes,
    tree,
    activePaneId
  };
}

/** 读存档；没有或坏了都返回 null（调用方回落到「开第一个会话」）。 */
export function loadLayout(): SavedLayout | null {
  const raw = readData(DataName.terminalLayout);
  if (!raw) return null;
  try {
    return sanitizeLayout(JSON.parse(raw));
  } catch (reason) {
    logWarn(
      "[layout] 启动还原数据解析失败，按「没有存档」处理",
      reason
    );
    return null;
  }
}

/** 写存档。 */
export function saveLayout(
  layout: SavedLayout
): void {
  writeData(
    DataName.terminalLayout,
    JSON.stringify(layout)
  );
}

/**
 * 清洗外部数据（纯函数，单测直接喂畸形输入）。
 *
 * 一致性要求：**树里的每个叶子都必须有对应的 pane 记录**，多余的记录
 * 直接丢掉；叶子缺记录时补一个空 pane（还原阶段会因为「没有标签」被摘掉）。
 */
export function sanitizeLayout(
  raw: unknown
): SavedLayout | null {
  const data = raw as Partial<SavedLayout> | null;
  if (!data || typeof data !== "object")
    return null;
  if (data.version !== LAYOUT_VERSION)
    return null;
  const tree = sanitizeNode(data.tree);
  if (!tree) return null;
  const paneList = Array.isArray(data.panes)
    ? data.panes
    : [];
  const byId = new Map<string, SavedPane>();
  for (const item of paneList) {
    const pane = sanitizePane(item);
    // 后出现的同名记录不覆盖先出现的：不确定性越小越好
    if (pane && !byId.has(pane.id))
      byId.set(pane.id, pane);
  }
  const leaves = collectLeafIds(tree);
  const panes = leaves.map(
    id =>
      byId.get(id) ?? {
        id,
        tabs: [],
        visible: -1
      }
  );
  const activePaneId =
    typeof data.activePaneId === "string" &&
    leaves.includes(data.activePaneId)
      ? data.activePaneId
      : (leaves[0] ?? "");
  return {
    version: LAYOUT_VERSION,
    panes,
    tree,
    activePaneId
  };
}

/** 清洗一个窗格记录；id 非法返回 null。 */
function sanitizePane(
  value: unknown
): SavedPane | null {
  const raw = value as Partial<SavedPane> | null;
  const id = String(raw?.id ?? "").trim();
  if (!id) return null;
  const tabs: SavedTab[] = [];
  if (Array.isArray(raw?.tabs)) {
    for (const tab of raw.tabs) {
      const item =
        tab as Partial<SavedTab> | null;
      const source = String(
        item?.source ?? ""
      ).trim();
      if (!source) continue;
      tabs.push(
        item?.copy
          ? { source, copy: true }
          : { source }
      );
    }
  }
  const visible = Number(raw?.visible);
  return {
    id,
    tabs,
    // 越界或非数 → -1（还原时回落到第一个标签）
    visible:
      Number.isInteger(visible) &&
      visible >= 0 &&
      visible < tabs.length
        ? visible
        : -1
  };
}

/** 清洗布局树；结构不合法返回 null。 */
function sanitizeNode(
  value: unknown,
  depth = 0
): PaneNode | null {
  // 深度上限：损坏数据里出现自引用/超深嵌套时别把栈打爆
  if (depth > 16) return null;
  const raw = value as Partial<PaneNode> | null;
  if (!raw || typeof raw !== "object")
    return null;
  if (raw.kind === "leaf") {
    const paneId = String(
      (raw as { paneId?: string }).paneId ?? ""
    ).trim();
    return paneId
      ? { kind: "leaf", paneId }
      : null;
  }
  if (raw.kind !== "split") return null;
  const split = raw as {
    id?: string;
    direction?: string;
    ratio?: number;
    first?: unknown;
    second?: unknown;
  };
  const id = String(split.id ?? "").trim();
  const direction =
    split.direction === "column"
      ? "column"
      : "row";
  const ratio = Number(split.ratio);
  const first = sanitizeNode(
    split.first,
    depth + 1
  );
  const second = sanitizeNode(
    split.second,
    depth + 1
  );
  // 缺一侧的分割节点无法成立：整棵子树当无效
  if (!id || !first || !second) return null;
  return {
    kind: "split",
    id,
    direction,
    ratio: Number.isFinite(ratio)
      ? Math.min(
          MAX_RATIO,
          Math.max(MIN_RATIO, ratio)
        )
      : 0.5,
    first,
    second
  };
}
