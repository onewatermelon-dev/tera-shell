import { describe, it, expect } from "vitest";
import {
  LAYOUT_VERSION,
  layoutOf,
  sanitizeLayout,
  type SavedLayout
} from "@/terminal/lib/session/terminalLayout";
import {
  applyLayout,
  sourceOrder
} from "@/terminal/lib/session/terminalRestore";
import type { PaneNode } from "@/terminal/lib/pane/paneLayout";
import type { PaneState } from "@/terminal/lib/session/paneGrid";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import type { SavedSession } from "@/sessions/lib/session";

/**
 * 启动还原：存档的抽取、清洗与「演回运行态」。
 *
 * 这套逻辑的失败模式都很安静：写坏一个字段可能只是「没还原」，
 * 也可能还原成「两个窗格显示同一个会话」。所以每条规则都钉死。
 *
 * 特别地：**同一来源可以有多只**（拆分窗格 / 复制标签）。早先按来源
 * 去重，把副本那只当成重复丢掉 —— 表现为「标签还原了但分屏没了」。
 */

/** 造一只打开的会话（只需要 id 与 sourceSessionId）。 */
function openSession(
  id: string,
  sourceSessionId: string
): OpenSession {
  return {
    id,
    sourceSessionId
  } as unknown as OpenSession;
}

/** 左右两格：pane-1 在左，pane-2 在右。 */
const TWO_PANES: PaneNode = {
  kind: "split",
  id: "split-1",
  direction: "row",
  ratio: 0.6,
  first: { kind: "leaf", paneId: "pane-1" },
  second: { kind: "leaf", paneId: "pane-2" }
};

/** 造一个已保存的会话定义。 */
function saved(id: string): SavedSession {
  return {
    id,
    name: id,
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "root"
  };
}

/** 副本实例的名字（还原时用）。 */
function copyName(source: SavedSession): string {
  return `${source.name} (2)`;
}

describe("从运行态抽存档", () => {
  it("标签记来源 id，不记运行时 id", () => {
    const opened = [openSession("s1", "s1")];
    const panes: PaneState[] = [
      {
        id: "pane-1",
        tabIds: ["s1"],
        visibleId: "s1"
      }
    ];
    const layout = layoutOf(
      opened,
      panes,
      { kind: "leaf", paneId: "pane-1" },
      "pane-1"
    );
    expect(layout.panes[0]?.tabs).toEqual([
      { source: "s1" }
    ]);
    expect(layout.version).toBe(LAYOUT_VERSION);
  });

  it("同一来源的另一个实例（拆分/复制）标成 copy", () => {
    const opened = [
      openSession("s1", "s1"),
      openSession("split-s1-123", "s1")
    ];
    const panes: PaneState[] = [
      {
        id: "pane-1",
        tabIds: ["s1", "split-s1-123"],
        visibleId: "split-s1-123"
      }
    ];
    const layout = layoutOf(
      opened,
      panes,
      { kind: "leaf", paneId: "pane-1" },
      "pane-1"
    );
    // 两个都在，第二个是副本
    expect(layout.panes[0]?.tabs).toEqual([
      { source: "s1" },
      { source: "s1", copy: true }
    ]);
    // visible 记的是序号（副本的运行时 id 是临时的，存下来没意义）
    expect(layout.panes[0]?.visible).toBe(1);
  });

  it("visible 不在本格时记 -1（还原时回落到第一个）", () => {
    const opened = [openSession("s1", "s1")];
    const panes: PaneState[] = [
      {
        id: "pane-1",
        tabIds: ["s1"],
        visibleId: "不存在"
      }
    ];
    const layout = layoutOf(
      opened,
      panes,
      { kind: "leaf", paneId: "pane-1" },
      "pane-1"
    );
    expect(layout.panes[0]?.visible).toBe(-1);
  });
});

describe("清洗存档", () => {
  it("版本不对直接丢弃", () => {
    expect(
      sanitizeLayout({
        version: 999,
        panes: [],
        tree: { kind: "leaf", paneId: "pane-1" }
      })
    ).toBeNull();
  });

  it("比例钳回合法区间", () => {
    const result = sanitizeLayout({
      version: LAYOUT_VERSION,
      panes: [],
      tree: {
        kind: "split",
        id: "s",
        direction: "row",
        ratio: 5,
        first: { kind: "leaf", paneId: "pane-1" },
        second: { kind: "leaf", paneId: "pane-2" }
      }
    });
    const tree = result?.tree;
    expect(tree?.kind).toBe("split");
    if (tree?.kind === "split")
      expect(tree.ratio).toBeLessThanOrEqual(0.8);
  });

  it("树的叶子与窗格记录按树对齐（多余的记录丢掉、缺的补空）", () => {
    const result = sanitizeLayout({
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [{ source: "s1" }],
          visible: 0
        },
        {
          id: "幽灵窗格",
          tabs: [{ source: "s9" }],
          visible: 0
        }
      ],
      tree: TWO_PANES
    });
    expect(
      result?.panes.map(pane => pane.id)
    ).toEqual(["pane-1", "pane-2"]);
    // 缺记录的那格补成空
    expect(result?.panes[1]?.tabs).toEqual([]);
    expect(result?.panes[1]?.visible).toBe(-1);
  });

  it("活动窗格非法时回落到第一个叶子", () => {
    const result = sanitizeLayout({
      version: LAYOUT_VERSION,
      panes: [],
      tree: TWO_PANES,
      activePaneId: "不存在"
    });
    expect(result?.activePaneId).toBe("pane-1");
  });

  it("结构损坏的树直接作废（不留半个布局）", () => {
    expect(
      sanitizeLayout({
        version: LAYOUT_VERSION,
        panes: [],
        tree: {
          kind: "split",
          id: "s",
          direction: "row",
          ratio: 0.5,
          first: {
            kind: "leaf",
            paneId: "pane-1"
          }
        }
      })
    ).toBeNull();
  });
});

describe("演回运行态", () => {
  it("按树的视觉顺序打开（先左后右）", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [{ source: "a" }],
          visible: 0
        },
        {
          id: "pane-2",
          tabs: [{ source: "b" }],
          visible: 0
        }
      ],
      tree: TWO_PANES,
      activePaneId: "pane-2"
    };
    const order: string[] = [];
    await applyLayout({
      saved: savedLayout,
      findSession: id => saved(id),
      openOne: async session => {
        order.push(session.id);
        return "opened" as const;
      },
      makeCopyName: copyName,
      apply: () => undefined
    });
    expect(order).toEqual(["a", "b"]);
  });

  it("会话被删 / 打不开都跳过，不影响其它标签", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [
            { source: "没了" },
            { source: "b" }
          ],
          visible: 1
        }
      ],
      tree: {
        kind: "leaf",
        paneId: "pane-1"
      } as PaneNode,
      activePaneId: "pane-1"
    };
    let applied: PaneState[] = [];
    const result = await applyLayout({
      saved: savedLayout,
      findSession: id =>
        id === "b" ? saved(id) : undefined,
      openOne: async () => "opened" as const,
      makeCopyName: copyName,
      apply: panes => {
        applied = panes;
      }
    });
    expect(result.skipped).toEqual(["没了"]);
    expect(result.restored).toBe(1);
    expect(applied[0]?.tabIds).toEqual(["b"]);
  });

  it("打不开的会话（要密码）不还原", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [{ source: "a" }],
          visible: 0
        }
      ],
      tree: {
        kind: "leaf",
        paneId: "pane-1"
      } as PaneNode,
      activePaneId: "pane-1"
    };
    const result = await applyLayout({
      saved: savedLayout,
      findSession: id => saved(id),
      openOne: async () => "password" as const,
      makeCopyName: copyName,
      apply: () => undefined
    });
    expect(result.restored).toBe(0);
    expect(result.skipped).toEqual(["a"]);
  });

  it("一个都没成功时不写运行态（交给上层回落到开第一个会话）", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [{ source: "a" }],
          visible: 0
        }
      ],
      tree: {
        kind: "leaf",
        paneId: "pane-1"
      } as PaneNode,
      activePaneId: "pane-1"
    };
    let applied = false;
    await applyLayout({
      saved: savedLayout,
      findSession: () => undefined,
      openOne: async () => "failed" as const,
      makeCopyName: copyName,
      apply: () => {
        applied = true;
      }
    });
    expect(applied).toBe(false);
  });

  it("空窗格从树里摘掉，剩下的一格顶替它的位置", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [],
          visible: -1
        },
        {
          id: "pane-2",
          tabs: [{ source: "b" }],
          visible: 0
        }
      ],
      tree: TWO_PANES,
      activePaneId: "pane-2"
    };
    // 用哨兵值而不是 null：TS 会对「只在回调里赋值」的变量做控制流
    // 收窄，null 会被推成 never，断言处反而报类型错
    let appliedTree: PaneNode = {
      kind: "leaf",
      paneId: "__none__"
    };
    await applyLayout({
      saved: savedLayout,
      findSession: id => saved(id),
      openOne: async () => "opened" as const,
      makeCopyName: copyName,
      apply: (_panes, tree) => {
        appliedTree = tree;
      }
    });
    // 摘掉 pane-1 后，树里只剩 pane-2 这一个叶子
    expect(appliedTree).toEqual({
      kind: "leaf",
      paneId: "pane-2"
    });
  });

  it("同一来源的两只（拆分出来的）分别落到两个窗格", async () => {
    // 这条是「分屏还原不出来」的回归点：两只同源，之前按来源去重，
    // 第二只被丢掉 → 第二格空了 → 分屏没了
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [{ source: "a" }],
          visible: 0
        },
        {
          id: "pane-2",
          tabs: [{ source: "a", copy: true }],
          visible: 0
        }
      ],
      tree: TWO_PANES,
      activePaneId: "pane-2"
    };
    const openedIds: string[] = [];
    let applied: PaneState[] = [];
    let appliedTree: PaneNode = {
      kind: "leaf",
      paneId: "__none__"
    };
    await applyLayout({
      saved: savedLayout,
      findSession: id => saved(id),
      openOne: async session => {
        openedIds.push(session.id);
        return "opened" as const;
      },
      makeCopyName: copyName,
      apply: (panes, tree) => {
        applied = panes;
        appliedTree = tree;
      }
    });
    // 副本是新开的一只（id 不同），不是复用原会话
    expect(openedIds).toHaveLength(2);
    expect(openedIds[0]).not.toBe(openedIds[1]);
    expect(openedIds[1]).toMatch(/^dup-a-/);
    // 两格都在，分屏保住
    expect(applied).toHaveLength(2);
    expect(appliedTree.kind).toBe("split");
  });

  it("副本实例的来源要指向原会话（否则下次存档就找不到它）", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [{ source: "a", copy: true }],
          visible: 0
        }
      ],
      tree: {
        kind: "leaf",
        paneId: "pane-1"
      } as PaneNode,
      activePaneId: "pane-1"
    };
    const origins: string[] = [];
    await applyLayout({
      saved: savedLayout,
      findSession: id => saved(id),
      openOne: async (_session, originId) => {
        origins.push(originId);
        return "opened" as const;
      },
      makeCopyName: copyName,
      apply: () => undefined
    });
    // 副本的 id 是临时的，但来源必须是原会话 "a"
    expect(origins).toEqual(["a"]);
  });

  it("visible 还原不回来时回落到本格第一个", async () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [
            { source: "a" },
            { source: "b" }
          ],
          visible: 1
        }
      ],
      tree: {
        kind: "leaf",
        paneId: "pane-1"
      } as PaneNode,
      activePaneId: "pane-1"
    };
    let applied: PaneState[] = [];
    await applyLayout({
      saved: savedLayout,
      findSession: id => saved(id),
      // 只让 a 打开得起来 → b 没了
      openOne: async session =>
        session.id === "a"
          ? ("opened" as const)
          : ("password" as const),
      makeCopyName: copyName,
      apply: panes => {
        applied = panes;
      }
    });
    expect(applied[0]?.visibleId).toBe("a");
  });
});

describe("打开顺序", () => {
  it("按视觉顺序列出全部标签", () => {
    const savedLayout: SavedLayout = {
      version: LAYOUT_VERSION,
      panes: [
        {
          id: "pane-1",
          tabs: [
            { source: "a" },
            { source: "b" }
          ],
          visible: 0
        },
        {
          id: "pane-2",
          tabs: [{ source: "a", copy: true }],
          visible: 0
        }
      ],
      tree: TWO_PANES,
      activePaneId: "pane-1"
    };
    expect(
      sourceOrder(savedLayout).map(
        tab => tab.source
      )
    ).toEqual(["a", "b", "a"]);
  });
});
