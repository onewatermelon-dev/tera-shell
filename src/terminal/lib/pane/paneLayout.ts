/**
 * 窗格布局树：把「左右两栏」推广成任意方向的二分树。
 *
 * ## 为什么用树而不是窗格数组
 * 一维的 `[pane0, pane1]` 只能表达左右并排。要支持上下分割，布局就必须
 * 记住「这两个窗格是竖着分的，那两个是横着分的」——也就是层级关系。
 * 树天然承载这个信息，且渲染时递归下去即可。
 *
 * ## 节点形态
 * - 叶子（`leaf`）：一个真实窗格，`paneId` 指向 panes 里的一条记录。
 * - 分割（`split`）：二分，声明沿哪个轴分（row=左右并排，column=上下堆叠）
 *   以及两块的比例（`ratio`，第一块占多少）。
 *
 * 全部是不可变操作：输入不变时返回原引用（便于 React 比较），
 * 有变化时只复制路径上的节点，未受影响的子树保持引用。
 */

/** 分割轴向：`row` 左右并排，`column` 上下堆叠。 */
export type SplitDirection = "row" | "column";

/** 真实窗格（树的叶子）。 */
export type PaneLeaf = {
  kind: "leaf";
  /** 对应 panes 数组里的哪一条 */
  paneId: string;
};

/** 二分节点。 */
export type PaneSplit = {
  kind: "split";
  /** 稳定标识：拖分隔条时用它回写 ratio，重排后也不会认错 */
  id: string;
  direction: SplitDirection;
  /** 第一块（`first`）占的比例，0.2~0.8 */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
};

export type PaneNode = PaneLeaf | PaneSplit;

/** 比例上下限：太窄的窗格终端会挤到不可用，留一点下限。 */
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

/** 把比例钳到合法区间；非法值（NaN/越界）一律回落到默认 0.5。 */
export function clampRatio(
  ratio: number
): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(
    MAX_RATIO,
    Math.max(MIN_RATIO, ratio)
  );
}

/** 单个窗格（无拆分）树。 */
export function createLeaf(
  paneId: string
): PaneLeaf {
  return { kind: "leaf", paneId };
}

/** 深度优先收集全部窗格 id（先 first 后 second，与视觉顺序一致）。 */
export function collectLeafIds(
  node: PaneNode
): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return [
    ...collectLeafIds(node.first),
    ...collectLeafIds(node.second)
  ];
}

/** 树里共有几个窗格。 */
export function countLeaves(
  node: PaneNode
): number {
  if (node.kind === "leaf") return 1;
  return (
    countLeaves(node.first) +
    countLeaves(node.second)
  );
}

/** 该 paneId 是否在树里（作为叶子存在）。 */
export function hasLeaf(
  node: PaneNode,
  paneId: string
): boolean {
  if (node.kind === "leaf")
    return node.paneId === paneId;
  return (
    hasLeaf(node.first, paneId) ||
    hasLeaf(node.second, paneId)
  );
}

/**
 * 找到 paneId 所在叶子，返回**整条路径**（根在前）。
 * 路径用于定位「这个窗格是被哪个 split 分出来的」，拖分隔条时要用。
 * 找不到返回 null。
 */
export function findLeafPath(
  node: PaneNode,
  paneId: string
): PaneNode[] | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? [node] : null;
  }
  const inFirst = findLeafPath(
    node.first,
    paneId
  );
  if (inFirst) return [node, ...inFirst];
  const inSecond = findLeafPath(
    node.second,
    paneId
  );
  if (inSecond) return [node, ...inSecond];
  return null;
}

/** 找到 paneId 对应的叶子节点本身。 */
export function findLeaf(
  node: PaneNode,
  paneId: string
): PaneLeaf | null {
  const path = findLeafPath(node, paneId);
  if (!path) return null;
  const leaf = path[path.length - 1];
  return leaf?.kind === "leaf" ? leaf : null;
}

/** 收集树里所有分割节点的 id。 */
export function collectSplitIds(
  node: PaneNode
): string[] {
  if (node.kind === "leaf") return [];
  return [
    node.id,
    ...collectSplitIds(node.first),
    ...collectSplitIds(node.second)
  ];
}

/**
 * 把 paneId 所在窗格一分为二，新窗格插到 `direction` 指示的一侧。
 *
 * - `row`：新窗格在右（second）
 * - `column`：新窗格在下（second）
 *
 * 一律插到 second，这样「向下拆分」永远是往下长、「向右拆分」永远往右长，
 * 与用户直觉一致。
 *
 * @param splitId 新分割节点的 id（由调用方生成，保证可追溯）
 * @returns 新树；paneId 不在树里时原样返回（不做无谓的复制）
 */
export function splitPane(
  node: PaneNode,
  paneId: string,
  direction: SplitDirection,
  newPaneId: string,
  splitId: string
): PaneNode {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) return node;
    return {
      kind: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: node,
      second: createLeaf(newPaneId)
    };
  }
  // 只重建真正变化的分支：未命中的子树保持原引用
  const first = splitPane(
    node.first,
    paneId,
    direction,
    newPaneId,
    splitId
  );
  if (first !== node.first)
    return { ...node, first };
  const second = splitPane(
    node.second,
    paneId,
    direction,
    newPaneId,
    splitId
  );
  if (second !== node.second)
    return { ...node, second };
  return node;
}

/**
 * 折叠掉一个窗格：它的父分割节点消失，兄弟子树顶替父节点的位置。
 *
 * 只有一个窗格时不能折叠（会变成空树），此时原样返回。
 * 调用方（关闭会话）应保证树里至少剩一个窗格。
 */
export function removePane(
  node: PaneNode,
  paneId: string
): PaneNode {
  // 叶子没有父分割可折叠：单窗格树原样返回
  if (node.kind === "leaf") return node;
  return pruneBranch(node, paneId) ?? node;
}

/**
 * 在一个分支内摘掉目标窗格，**返回 null 表示整个分支应当消失**。
 *
 * 分割节点的两侧有一侧被摘空时，这个分割节点本身就不存在了 ——
 * 剩下那一侧直接顶替它的位置（父层随之少一级）。
 */
function pruneBranch(
  node: PaneNode,
  paneId: string
): PaneNode | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const first = pruneBranch(node.first, paneId);
  const second = pruneBranch(node.second, paneId);
  // 两侧都被摘空只可能是畸形树（分割节点至少含两个叶子），兜底保底
  if (first === null && second === null)
    return null;
  if (first === null) return second;
  if (second === null) return first;
  // 两侧都没变 → 保持原引用，避免无谓的重渲染
  if (
    first === node.first &&
    second === node.second
  )
    return node;
  return { ...node, first, second };
}

/**
 * 拖分隔条：按 splitId 定位节点并更新比例。
 * 找不到该 id 或比例没变化时返回原引用。
 */
export function setSplitRatio(
  node: PaneNode,
  splitId: string,
  ratio: number
): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) {
    const next = clampRatio(ratio);
    if (next === node.ratio) return node;
    return { ...node, ratio: next };
  }
  const first = setSplitRatio(
    node.first,
    splitId,
    ratio
  );
  if (first !== node.first)
    return { ...node, first };
  const second = setSplitRatio(
    node.second,
    splitId,
    ratio
  );
  if (second !== node.second)
    return { ...node, second };
  return node;
}
