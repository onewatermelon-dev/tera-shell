/**
 * 拓扑关系图：主机 → 服务 → 端口 → 进程 这类**层级关系**，画成图而不是
 * 让模型用缩进文本描述。
 *
 * ## 与 metric-chart 共用围栏块
 *
 * 都用 ```metric-chart，靠 `type` 区分：
 * - `type: "line" | "bar"` → 数值图表（points）
 * - `type: "graph"`        → 拓扑图（nodes + edges）
 *
 * ```metric-chart
 * { "title": "web-01 服务拓扑", "type": "graph",
 *   "nodes": [{"id":"host","label":"web-01","kind":"host"},
 *             {"id":"nginx","label":"nginx","kind":"service"},
 *             {"id":"443","label":"443/tcp","kind":"port"}],
 *   "edges": [{"from":"host","to":"nginx"},
 *             {"from":"nginx","to":"443"}] }
 * ```
 *
 * ## 布局：BFS 分层 + 纵向流动
 *
 * 刻意**不用力导向**：
 * - 力导向要迭代、结果不稳定（同样输入两次渲染位置不同），也没法单测；
 * - AI 面板只有 300-400px 宽，横向排 4 层会窄到看不清标签。
 * 所以按「层 → 行」纵向排，同层节点横向均分。
 */

/** 节点种类：决定左侧色条的颜色（语义来自提示词的约定）。 */
export type TopologyKind =
  "host" | "service" | "port" | "process";

/** 一个节点。 */
export type TopologyNode = {
  id: string;
  label: string;
  kind: TopologyKind;
};

/** 一条有向边（父 → 子）。 */
export type TopologyEdge = {
  from: string;
  to: string;
};

/** 解析后的拓扑规格。 */
export type TopologySpec = {
  title: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
};

/**
 * 上限：节点 40 / 边 80。
 *
 * 超过就**不是"关系图"了**，而是把整台机器的进程树倒上来 —— 那种规模
 * 应该先用命令筛，再画图。截断时保留声明顺序（模型通常最重要的在前）。
 */
export const MAX_NODES = 40;
export const MAX_EDGES = 80;

const KINDS: TopologyKind[] = [
  "host",
  "service",
  "port",
  "process"
];

/** 解析 type=graph 的围栏块；不是图/格式坏都返回 null。 */
export function parseTopologyChart(
  raw: string
): TopologySpec | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object")
    return null;
  const obj = data as Record<string, unknown>;
  // 只认 graph：数值图由 parseMetricChart 处理
  if (obj.type !== "graph") return null;
  if (!Array.isArray(obj.nodes)) return null;

  const nodes: TopologyNode[] = [];
  const seen = new Set<string>();
  for (const item of obj.nodes.slice(
    0,
    MAX_NODES
  )) {
    if (!item || typeof item !== "object")
      continue;
    const node = item as Record<string, unknown>;
    const id = String(node.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = String(node.kind ?? "");
    nodes.push({
      id,
      label:
        String(node.label ?? "")
          .trim()
          .slice(0, 32) || id,
      kind: KINDS.includes(kind as TopologyKind)
        ? (kind as TopologyKind)
        : "service"
    });
  }
  if (nodes.length === 0) return null;

  const edges: TopologyEdge[] = [];
  const edgeKeys = new Set<string>();
  const rawEdges = Array.isArray(obj.edges)
    ? obj.edges
    : [];
  for (const item of rawEdges.slice(
    0,
    MAX_EDGES
  )) {
    if (!item || typeof item !== "object")
      continue;
    const edge = item as Record<string, unknown>;
    const from = String(edge.from ?? "").trim();
    const to = String(edge.to ?? "").trim();
    // 悬空边直接丢：画不出来，也会把布局算歪
    if (!seen.has(from) || !seen.has(to))
      continue;
    if (from === to) continue;
    const key = `${from}→${to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from, to });
  }

  return {
    title:
      typeof obj.title === "string"
        ? obj.title.slice(0, 80)
        : "",
    nodes,
    edges
  };
}

/** 布局产物：直接给 SVG 用的坐标。 */
export type TopologyLayout = {
  /** 每个节点的框与层级 */
  nodes: {
    id: string;
    label: string;
    kind: TopologyKind;
    level: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  /** 每条边的端点（父的下沿中点 → 子的上沿中点） */
  edges: {
    from: string;
    to: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }[];
  width: number;
  height: number;
};

/** 节点高度与层间留白（留白给连线）。 */
const NODE_H = 26;
const ROW_GAP = 30;
const MARGIN = 8;
/** 单节点最大宽度：再宽就只是空盒子。 */
const MAX_NODE_W = 132;

/**
 * 按 BFS 层级算布局。
 *
 * - 层号 = 从根（无入边）出发的最短距离；环里访问不到的节点兜底放 0 层；
 * - 同层节点按**声明顺序**横向均分（模型一般按重要性排）；
 * - 父节点下沿中点连到子节点上沿中点，纵向流动。
 */
export function buildTopologyLayout(
  spec: TopologySpec,
  width: number
): TopologyLayout {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of spec.nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of spec.edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(
      edge.to,
      (indegree.get(edge.to) ?? 0) + 1
    );
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const node of spec.nodes)
    if ((indegree.get(node.id) ?? 0) === 0) {
      level.set(node.id, 0);
      queue.push(node.id);
    }
  // 全是环（没有根）时拿第一个节点当根，避免所有节点挤在 0 层
  if (queue.length === 0 && spec.nodes[0]) {
    level.set(spec.nodes[0].id, 0);
    queue.push(spec.nodes[0].id);
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const base = level.get(current) ?? 0;
    for (const next of outgoing.get(current) ??
      []) {
      // 已定层就不再改：环里的回边不会把节点往下拽
      if (level.has(next)) continue;
      level.set(next, base + 1);
      queue.push(next);
    }
  }
  // 环里访问不到的（理论上不会发生，防御性兜底）
  for (const node of spec.nodes)
    if (!level.has(node.id))
      level.set(node.id, 0);

  const byLevel = new Map<
    string,
    { id: string; level: number }[]
  >();
  for (const node of spec.nodes) {
    const at = level.get(node.id) ?? 0;
    const bucket = byLevel.get(String(at)) ?? [];
    bucket.push({ id: node.id, level: at });
    byLevel.set(String(at), bucket);
  }
  const levelCount = byLevel.size;

  const placed = new Map<
    string,
    TopologyLayout["nodes"][number]
  >();
  const levels = [...byLevel.keys()]
    .map(Number)
    .sort((a, b) => a - b);
  for (const at of levels) {
    const bucket = byLevel.get(String(at)) ?? [];
    const columns = bucket.length;
    const slotWidth =
      (width - MARGIN * 2) / Math.max(1, columns);
    const nodeWidth = Math.min(
      MAX_NODE_W,
      Math.max(48, slotWidth - 10)
    );
    bucket.forEach((item, index) => {
      const node = spec.nodes.find(
        entry => entry.id === item.id
      );
      if (!node) return;
      const centerX =
        MARGIN +
        slotWidth * index +
        slotWidth / 2;
      placed.set(item.id, {
        id: node.id,
        label: node.label,
        kind: node.kind,
        level: at,
        x: centerX - nodeWidth / 2,
        y: MARGIN + at * (NODE_H + ROW_GAP),
        width: nodeWidth,
        height: NODE_H
      });
    });
  }

  const edges = spec.edges.flatMap(edge => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return [];
    return [
      {
        from: edge.from,
        to: edge.to,
        x1: from.x + from.width / 2,
        y1: from.y + from.height,
        x2: to.x + to.width / 2,
        y2: to.y
      }
    ];
  });

  return {
    nodes: [...placed.values()],
    edges,
    width,
    height:
      MARGIN * 2 +
      Math.max(1, levelCount) * NODE_H +
      Math.max(0, levelCount - 1) * ROW_GAP
  };
}

/** 标签按节点宽度截断：SVG 没有 ellipsis，只能自己算字符数。 */
export function fitLabel(
  label: string,
  width: number
): string {
  // 10px 字号下中文字宽约等于字号，英文约 0.55 倍 —— 取 0.62 折中
  const capacity = Math.max(
    2,
    Math.floor((width - 12) / 6.2)
  );
  return label.length <= capacity
    ? label
    : `${label.slice(0, capacity - 1)}…`;
}
