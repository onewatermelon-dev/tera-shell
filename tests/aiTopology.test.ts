import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import {
  MAX_EDGES,
  MAX_NODES,
  buildTopologyLayout,
  fitLabel,
  parseTopologyChart,
  type TopologySpec
} from "@/terminal/lib/ai/topology";

const sample = {
  title: "web-01 服务拓扑",
  type: "graph",
  nodes: [
    { id: "host", label: "web-01", kind: "host" },
    {
      id: "nginx",
      label: "nginx",
      kind: "service"
    },
    { id: "443", label: "443/tcp", kind: "port" },
    {
      id: "w1",
      label: "nginx: worker",
      kind: "process"
    }
  ],
  edges: [
    { from: "host", to: "nginx" },
    { from: "nginx", to: "443" },
    { from: "nginx", to: "w1" }
  ]
};

describe("拓扑解析", () => {
  it("完整数据", () => {
    const spec = parseTopologyChart(
      JSON.stringify(sample)
    );
    expect(spec?.title).toBe("web-01 服务拓扑");
    expect(spec?.nodes).toHaveLength(4);
    expect(spec?.edges).toHaveLength(3);
    expect(spec?.nodes[0]).toEqual({
      id: "host",
      label: "web-01",
      kind: "host"
    });
  });

  it("非 graph / 坏 JSON / 无节点 → null（回落代码块）", () => {
    expect(
      parseTopologyChart(
        JSON.stringify({
          ...sample,
          type: "line"
        })
      )
    ).toBeNull();
    expect(
      parseTopologyChart("{ 还没写完")
    ).toBeNull();
    expect(
      parseTopologyChart(
        JSON.stringify({ type: "graph" })
      )
    ).toBeNull();
    expect(
      parseTopologyChart(
        JSON.stringify({
          type: "graph",
          nodes: []
        })
      )
    ).toBeNull();
  });

  it("未知 kind 兜底 service；缺 label 用 id", () => {
    const spec = parseTopologyChart(
      JSON.stringify({
        type: "graph",
        nodes: [{ id: "x", kind: "容器" }]
      })
    );
    expect(spec?.nodes[0]?.kind).toBe("service");
    expect(spec?.nodes[0]?.label).toBe("x");
  });

  it("重复 id 去重，悬空边与自环丢弃", () => {
    const spec = parseTopologyChart(
      JSON.stringify({
        type: "graph",
        nodes: [
          { id: "a" },
          { id: "a" },
          { id: "b" }
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "ghost" },
          { from: "a", to: "a" },
          { from: "a", to: "b" }
        ]
      })
    );
    expect(spec?.nodes).toHaveLength(2);
    expect(spec?.edges).toEqual([
      { from: "a", to: "b" }
    ]);
  });

  it("节点/边超上限截断", () => {
    const nodes = Array.from(
      { length: MAX_NODES + 5 },
      (_item, index) => ({ id: `n${index}` })
    );
    const edges = Array.from(
      { length: MAX_EDGES + 5 },
      (_item, index) => ({
        from: "n0",
        to: `n${index + 1}`
      })
    );
    const spec = parseTopologyChart(
      JSON.stringify({
        type: "graph",
        nodes,
        edges: edges.filter(
          edge =>
            Number(edge.to.slice(1)) < MAX_NODES
        )
      })
    );
    expect(spec?.nodes).toHaveLength(MAX_NODES);
    expect(
      spec!.edges.length
    ).toBeLessThanOrEqual(MAX_EDGES);
  });
});

describe("分层布局", () => {
  const spec = parseTopologyChart(
    JSON.stringify(sample)
  ) as TopologySpec;

  it("按 BFS 分层：主机 0 层，服务 1 层，端口/进程 2 层", () => {
    const layout = buildTopologyLayout(spec, 360);
    const level = (id: string) =>
      layout.nodes.find(node => node.id === id)
        ?.level;
    expect(level("host")).toBe(0);
    expect(level("nginx")).toBe(1);
    expect(level("443")).toBe(2);
    expect(level("w1")).toBe(2);
  });

  it("层越高 Y 越大（纵向流动）", () => {
    const layout = buildTopologyLayout(spec, 360);
    const y = (id: string) =>
      layout.nodes.find(node => node.id === id)!
        .y;
    expect(y("host")).toBeLessThan(y("nginx"));
    expect(y("nginx")).toBeLessThan(y("443"));
  });

  it("同层节点不重叠（横向均分）", () => {
    const layout = buildTopologyLayout(spec, 360);
    const sameLevel = layout.nodes.filter(
      node => node.level === 2
    );
    expect(sameLevel).toHaveLength(2);
    const [left, right] = sameLevel.sort(
      (a, b) => a.x - b.x
    );
    expect(
      left!.x + left!.width
    ).toBeLessThanOrEqual(right!.x);
  });

  it("节点不超出画布宽度", () => {
    const layout = buildTopologyLayout(spec, 300);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(
        node.x + node.width
      ).toBeLessThanOrEqual(300);
    }
  });

  it("边从父的下沿连到子的上沿（向下流动）", () => {
    const layout = buildTopologyLayout(spec, 360);
    const host = layout.nodes.find(
      node => node.id === "host"
    )!;
    const edge = layout.edges.find(
      item => item.from === "host"
    )!;
    expect(edge.y1).toBe(host.y + host.height);
    // 子节点在父节点下方：终点 Y 更大
    expect(edge.y2).toBeGreaterThan(edge.y1);
  });

  it("环不会死循环：无根时也能排出层", () => {
    const cyclic = parseTopologyChart(
      JSON.stringify({
        type: "graph",
        nodes: [{ id: "a" }, { id: "b" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" }
        ]
      })
    ) as TopologySpec;
    const layout = buildTopologyLayout(
      cyclic,
      360
    );
    expect(layout.nodes).toHaveLength(2);
    expect(
      layout.nodes.every(node =>
        Number.isFinite(node.y)
      )
    ).toBe(true);
  });

  it("高度随层数增长", () => {
    const two = buildTopologyLayout(
      parseTopologyChart(
        JSON.stringify({
          type: "graph",
          nodes: [{ id: "a" }, { id: "b" }],
          edges: [{ from: "a", to: "b" }]
        })
      ) as TopologySpec,
      360
    );
    expect(two.height).toBeGreaterThan(0);
    expect(two.height).toBeLessThan(
      buildTopologyLayout(spec, 360).height
    );
  });
});

describe("标签截断", () => {
  it("窄节点截断并加省略号", () => {
    const long =
      "nginx: worker process 很长很长的名字";
    expect(fitLabel(long, 60).endsWith("…")).toBe(
      true
    );
    expect(
      fitLabel(long, 60).length
    ).toBeLessThan(long.length);
  });

  it("短标签原样返回", () => {
    expect(fitLabel("nginx", 132)).toBe("nginx");
  });
});

describe("渲染与接线", () => {
  it("组件渲染出节点矩形与连线", async () => {
    const { AiTopologyGraph } =
      await import("@/terminal/components/ai/AiTopologyGraph");
    const spec = parseTopologyChart(
      JSON.stringify(sample)
    ) as TopologySpec;
    const html = renderToStaticMarkup(
      createElement(AiTopologyGraph, { spec })
    );
    expect(html).toContain("<svg");
    expect(html).toContain("web-01 服务拓扑");
    expect(html).toContain("nginx");
    // 3 条边
    expect(
      html.match(/<line/g) ?? []
    ).toHaveLength(3);
    // 节点数与关系数提示
    expect(html).toContain("4 节点");
  }, 60_000);

  it("markdown 层：metric-chart 里先试数值图，再试拓扑图", async () => {
    const src = (
      await import("@/terminal/components/ai/AiMarkdown.tsx?raw")
    ).default;
    expect(src).toContain("parseTopologyChart");
    expect(src).toContain("AiTopologyGraph");
    // 顺序：数值图在前（points 优先），拓扑图兜底
    expect(
      src.indexOf("parseMetricChart")
    ).toBeLessThan(
      src.indexOf("parseTopologyChart")
    );
  });

  it("提示词写了 graph 结构与 kind 取值", async () => {
    const { SYSTEM_PROMPT } =
      await import("@/terminal/lib/ai/promptContext");
    expect(SYSTEM_PROMPT).toContain(
      '"type":"graph"'
    );
    expect(SYSTEM_PROMPT).toContain("kind");
    expect(SYSTEM_PROMPT).toContain("process");
  });
});
