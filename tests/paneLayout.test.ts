import { describe, it, expect } from "vitest";
import {
  clampRatio,
  collectLeafIds,
  collectSplitIds,
  countLeaves,
  createLeaf,
  findLeaf,
  findLeafPath,
  hasLeaf,
  removePane,
  setSplitRatio,
  splitPane,
  MIN_RATIO,
  MAX_RATIO,
  type PaneNode
} from "@/terminal/lib/paneLayout";

/**
 * 搭一棵两列三行的网格：主栏再纵向二分，形成 3 个窗格。
 *
 *        ┌─────────┬─────────┐
 *        │   a    │    b    │
 *        │         ├─────────┤
 *        │         │    c    │
 *        └─────────┴─────────┘
 */
function makeGrid(): PaneNode {
  let tree = splitPane(
    createLeaf("a"),
    "a",
    "row",
    "b",
    "s1"
  );
  tree = splitPane(
    tree,
    "b",
    "column",
    "c",
    "s2"
  );
  return tree;
}

describe("窗格树：构造与查询", () => {
  it("单窗格树就是一个叶子", () => {
    const tree = createLeaf("main");
    expect(tree.kind).toBe("leaf");
    expect(countLeaves(tree)).toBe(1);
    expect(collectLeafIds(tree)).toEqual([
      "main"
    ]);
  });

  it("横向拆分出第二栏，叶子按视觉顺序排列", () => {
    const tree = splitPane(
      createLeaf("a"),
      "a",
      "row",
      "b",
      "s1"
    );
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") return;
    expect(tree.direction).toBe("row");
    expect(tree.id).toBe("s1");
    expect(tree.ratio).toBe(0.5);
    expect(collectLeafIds(tree)).toEqual([
      "a",
      "b"
    ]);
  });

  it("纵向拆分记录 column 方向", () => {
    const tree = splitPane(
      createLeaf("a"),
      "a",
      "column",
      "b",
      "s1"
    );
    if (tree.kind !== "split") return;
    expect(tree.direction).toBe("column");
    expect(countLeaves(tree)).toBe(2);
  });

  it("新窗格一律插到 second：row 是右、column 是下", () => {
    const row = splitPane(
      createLeaf("a"),
      "a",
      "row",
      "new",
      "s"
    );
    expect(collectLeafIds(row)).toEqual([
      "a",
      "new"
    ]);
    const col = splitPane(
      createLeaf("a"),
      "a",
      "column",
      "new",
      "s"
    );
    expect(collectLeafIds(col)).toEqual([
      "a",
      "new"
    ]);
  });

  it("嵌套拆分形成 3 个窗格，分割 id 都能收上来", () => {
    const tree = makeGrid();
    expect(countLeaves(tree)).toBe(3);
    expect(collectLeafIds(tree)).toEqual([
      "a",
      "b",
      "c"
    ]);
    expect(collectSplitIds(tree).sort()).toEqual([
      "s1",
      "s2"
    ]);
  });

  it("hasLeaf / findLeaf 只认叶子，findLeaf 找不到返回 null", () => {
    const tree = makeGrid();
    expect(hasLeaf(tree, "b")).toBe(true);
    expect(hasLeaf(tree, "zzz")).toBe(false);
    expect(findLeaf(tree, "c")?.paneId).toBe("c");
    expect(findLeaf(tree, "zzz")).toBeNull();
  });

  it("findLeafPath 从根到叶依次是根、分割、叶子", () => {
    const path = findLeafPath(makeGrid(), "c");
    expect(path).not.toBeNull();
    expect(path?.map(node => node.kind)).toEqual([
      "split",
      "split",
      "leaf"
    ]);
    // 根节点的 id 是第一次拆分产生的 s1
    expect(
      path?.[0]?.kind === "split"
        ? path[0].id
        : ""
    ).toBe("s1");
    expect(
      path?.[1]?.kind === "split"
        ? path[1].id
        : ""
    ).toBe("s2");
  });

  it("拆分不存在的窗格时原样返回（同一引用）", () => {
    const tree = makeGrid();
    expect(
      splitPane(tree, "zzz", "row", "new", "s9")
    ).toBe(tree);
  });
});

describe("窗格树：折叠", () => {
  it("摘掉叶子后兄弟顶替父分割，树少一级", () => {
    const tree = makeGrid();
    const next = removePane(tree, "c");
    // 原本 3 个窗格 → 2 个
    expect(countLeaves(next)).toBe(2);
    expect(collectLeafIds(next)).toEqual([
      "a",
      "b"
    ]);
    // 只剩一个分割节点了
    expect(collectSplitIds(next)).toEqual(["s1"]);
    if (next.kind !== "split") return;
    expect(next.direction).toBe("row");
  });

  it("摘掉 first 侧的叶子同样能折叠", () => {
    const tree = makeGrid();
    const next = removePane(tree, "b");
    expect(collectLeafIds(next)).toEqual([
      "a",
      "c"
    ]);
  });

  it("嵌套深处的叶子被摘掉后其祖先分割消失", () => {
    // 先造 a/b，再把 b 下面挂 c、d，然后摘掉 c
    let tree = makeGrid();
    tree = splitPane(tree, "c", "row", "d", "s3");
    expect(countLeaves(tree)).toBe(4);
    const next = removePane(tree, "c");
    expect(collectLeafIds(next)).toEqual([
      "a",
      "b",
      "d"
    ]);
    expect(collectSplitIds(next).sort()).toEqual([
      "s1",
      "s2"
    ]);
  });

  it("只剩两个窗格时摘掉一个，回到单分割结构", () => {
    const tree = splitPane(
      createLeaf("a"),
      "a",
      "row",
      "b",
      "s1"
    );
    const next = removePane(tree, "a");
    expect(collectLeafIds(next)).toEqual(["b"]);
    // 树退化成裸叶子
    expect(next.kind).toBe("leaf");
  });

  it("单窗格树不可折叠（避免变成空树）", () => {
    const tree = createLeaf("only");
    expect(removePane(tree, "only")).toBe(tree);
  });

  it("摘不存在的窗格时保持原引用", () => {
    const tree = makeGrid();
    expect(removePane(tree, "zzz")).toBe(tree);
  });
});

describe("窗格树：分隔条比例", () => {
  it("clampRatio 把比例限制在 20%~80%", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.05)).toBe(MIN_RATIO);
    expect(clampRatio(0.95)).toBe(MAX_RATIO);
    expect(clampRatio(0.3)).toBe(0.3);
  });

  it("非法比例回落到 0.5（拖过头不会把窗格压没）", () => {
    // NaN 与 ±Infinity 都过不了 Number.isFinite，一律回安全默认，
    // 而不是钳到边界 —— 异常输入不该被当成"用户拖到了最边上"
    expect(clampRatio(NaN)).toBe(0.5);
    expect(clampRatio(Infinity)).toBe(0.5);
    expect(clampRatio(-Infinity)).toBe(0.5);
  });

  it("setSplitRatio 按 id 命中对应节点", () => {
    const tree = makeGrid();
    const next = setSplitRatio(tree, "s2", 0.7);
    if (next.kind !== "split") return;
    // 根是 s1，不该被动到
    expect(next.ratio).toBe(0.5);
    if (next.second.kind !== "split") return;
    expect(next.second.ratio).toBe(0.7);
  });

  it("比例越界自动钳制写回", () => {
    const tree = makeGrid();
    const next = setSplitRatio(tree, "s1", 0.99);
    if (next.kind !== "split") return;
    expect(next.ratio).toBe(MAX_RATIO);
  });

  it("比例没变化时返回原引用（避免无谓重渲染）", () => {
    const tree = makeGrid();
    expect(setSplitRatio(tree, "s1", 0.5)).toBe(
      tree
    );
  });

  it("拖不存在的分隔条保持原引用", () => {
    const tree = makeGrid();
    expect(setSplitRatio(tree, "s9", 0.6)).toBe(
      tree
    );
  });

  it("叶子节点上没有任何分割可拖", () => {
    const tree = createLeaf("a");
    expect(setSplitRatio(tree, "s1", 0.6)).toBe(
      tree
    );
  });
});

/**
 * 窗格折叠的副作用约束（回归测试）。
 *
 * 背景：曾把 `setPanes` 写进 `setTree` 的 updater 内部（"改树时顺手同步
 * 窗格记录"），看着自然，实则是**在 state updater 里做副作用**：
 *  ① React 在 StrictMode 下调用 updater 两次 → setPanes 重复执行；
 *  ② 同一次 close() 里调用方自己也会 setPanes，两次写互相覆盖，
 *     结果折叠后**剩下窗格的标签被清空**（用户报「关闭拆分会话后
 *     之前的会话内容被截断」）。
 *
 * 纯函数 updater 的价值就在于"调用几次结果都一样"，所以这些性质可以直接
 * 断言 —— 不需要真的跑 React。
 */
describe("窗格折叠：状态更新必须无副作用", () => {
  /** 模拟 setPanes：同步写 ref + 通知渲染 */
  function makeStore(initial: string[]) {
    const ref = { current: initial };
    const calls: string[][] = [];
    const setPanes = (next: string[]) => {
      ref.current = next;
      calls.push(next);
    };
    return { ref, calls, setPanes };
  }

  it("updater 被调用两次时，同步 panes 的结果必须一致", () => {
    const panes = makeStore(["p1"]);
    const tree: PaneNode = splitPane(
      createLeaf("p1"),
      "p1",
      "row",
      "p2",
      "s1"
    );

    // 复现旧写法：副作用包在 updater 里
    const updater = (
      prev: PaneNode
    ): PaneNode => {
      const next = removePane(prev, "p2");
      // updater 里调 setPanes —— React 会重放这段
      panes.setPanes(["p1"]);
      return next;
    };
    updater(tree);
    updater(tree);

    // updater 跑了两次 → setPanes 也被调两次（副作用外泄的信号）
    expect(panes.calls.length).toBe(2);
    // 但纯函数 updater 本身必须幂等：树的结果两次一致
    expect(updater(tree)).toBe(updater(tree));
  });

  it("正确写法：updater 内不产生副作用，幂等且无重复写入", () => {
    const tree = splitPane(
      createLeaf("p1"),
      "p1",
      "row",
      "p2",
      "s1"
    );
    const updater = (prev: PaneNode) =>
      removePane(prev, "p2");
    // updater 只算树，不碰外部状态 → 调用任意次结果一致
    const a = updater(tree);
    const b = updater(tree);
    expect(a).toEqual(b);
    expect(collectLeafIds(a)).toEqual(["p1"]);
  });

  it("折叠后剩下的窗格记录与树保持一致（无幽灵、无丢标签）", () => {
    // 模拟真实场景：p1 有标签 s1，p2 有标签 s2，关掉 p2 后折叠
    const panesBefore = [
      {
        id: "p1",
        tabIds: ["s1"],
        visibleId: "s1"
      },
      {
        id: "p2",
        tabIds: ["s2"],
        visibleId: "s2"
      }
    ];
    let tree: PaneNode = splitPane(
      createLeaf("p1"),
      "p1",
      "row",
      "p2",
      "s1"
    );
    const ids = new Set(collectLeafIds(tree));
    // 同步 panes：只保留仍在树里的窗格，并补上新出现的
    const kept = panesBefore.filter(pane =>
      ids.has(pane.id)
    );
    expect(kept.map(p => p.id)).toEqual([
      "p1",
      "p2"
    ]);

    // 折叠 p2
    tree = removePane(tree, "p2");
    const idsAfter = new Set(
      collectLeafIds(tree)
    );
    const keptAfter = kept.filter(pane =>
      idsAfter.has(pane.id)
    );
    // ⚠️ 这就是回归点：p1 必须还在，且**保留它原有的 s1 标签**
    expect(keptAfter.map(p => p.id)).toEqual([
      "p1"
    ]);
    expect(keptAfter[0]?.tabIds).toEqual(["s1"]);
  });

  it("新建窗格时 panes 要补空记录，否则标签条渲染不出来", () => {
    const panes = [
      {
        id: "p1",
        tabIds: ["s1"],
        visibleId: "s1"
      }
    ];
    const tree = splitPane(
      createLeaf("p1"),
      "p1",
      "column",
      "p2",
      "s1"
    );
    const ids = new Set(collectLeafIds(tree));
    const next = [...panes];
    for (const id of ids) {
      if (!next.some(p => p.id === id)) {
        next.push({
          id,
          tabIds: [],
          visibleId: ""
        });
      }
    }
    expect(next.map(p => p.id)).toEqual([
      "p1",
      "p2"
    ]);
    // 已有窗格的标签不能被这一步冲掉
    expect(next[0]?.tabIds).toEqual(["s1"]);
  });
});
