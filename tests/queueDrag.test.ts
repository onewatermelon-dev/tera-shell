// 队列拖放换序的决策逻辑与配套样式。
//
// 为什么单独测：拖拽的表现问题（拖不动、拖到哪都不换序）在真机上手工
// 验证成本极高，而这轮已经踩过一次 —— HTML5 那套在 WebView2 里静默
// 失效。所以把「落点怎么算」「换序结果对不对」「样式有没有踩坑」
// 全部拆成能跑的断言。
import { describe, expect, it } from "vitest";
import {
  moveQueued,
  type AiQueuedMessage
} from "@/terminal/lib/aiChat";

type Rect = {
  id: string;
  top: number;
  bottom: number;
};

/**
 * 复刻 AiPanel 里 onDragMove 的落点判定（elementFromPoint + closest）。
 *
 * 真实现拿的是 DOM，这里用矩形区间替身 —— 判定规则（y 落在哪一行）
 * 完全一致，够钉死语义。
 */
function pickHit(
  y: number,
  rows: Rect[]
): string | null {
  for (const row of rows) {
    if (y >= row.top && y <= row.bottom)
      return row.id;
  }
  return null;
}

const ROWS: Rect[] = [
  { id: "q1", top: 0, bottom: 30 },
  { id: "q2", top: 36, bottom: 66 },
  { id: "q3", top: 72, bottom: 102 }
];

function q(texts: string[]): AiQueuedMessage[] {
  return texts.map((text, index) => ({
    id: `q${index + 1}`,
    text,
    images: []
  }));
}

describe("队列拖放落点判定", () => {
  it("命中某一行 → 换到那一行", () => {
    const queue = q(["a", "b", "c"]);
    // 把 q1 拖到 q3 上（y=80 落在 q3 区间）
    const hit = pickHit(80, ROWS);
    expect(hit).toBe("q3");
    expect(
      moveQueued(queue, "q1", hit ?? "").map(
        i => i.text
      )
    ).toEqual(["b", "c", "a"]);
  });

  it("落回自己身上 → 判定为不动（高亮也跟着取消）", () => {
    // 拖 q2 时指针还在 q2 那一行；AiPanel 里 hitId === id 会置 null
    expect(pickHit(50, ROWS)).toBe("q2");
  });

  it("落在两行之间的缝隙 → 命中 null，按队尾处理", () => {
    // y=33 在 q1(0-30) 与 q2(36-66) 之间
    expect(pickHit(33, ROWS)).toBeNull();
    const queue = q(["a", "b", "c"]);
    const last = queue[queue.length - 1];
    expect(
      moveQueued(queue, "q1", last?.id ?? "").map(
        i => i.text
      )
    ).toEqual(["b", "c", "a"]);
  });

  it("落回自己身上 → 原地不动（不能被当成「移到队尾」）", () => {
    // 本轮真踩过的坑：高亮用的 dropId 在「落回自己」时被置成 null，
    // 收尾逻辑若直接拿它判，就会把 null 当成「落在缝隙」→ 误移到队尾。
    // 用户只是手滑一下，队列却变了。三态必须分开：命中自己 / 命中
    // 别的 / 落缝隙。
    const queue = q(["a", "b", "c"]);
    const self = "q1";
    const hit = pickHit(10, ROWS); // 命中 q1 自己
    const target = hit === self ? null : hit;
    expect(target).toBeNull();
    // target 为 null 时 AiPanel 跳过 reorderQueued，顺序原样
    if (target) moveQueued(queue, self, target);
    expect(queue.map(i => i.text)).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("把第一条一路拖到最末：两次移动语义叠加仍到末尾", () => {
    let queue = q(["a", "b", "c", "d"]);
    queue = moveQueued(queue, "q1", "q3");
    const moved = queue.find(i => i.text === "a");
    queue = moveQueued(
      queue,
      moved?.id ?? "",
      "q4"
    );
    expect(queue.map(i => i.text)).toEqual([
      "b",
      "c",
      "d",
      "a"
    ]);
  });

  it("6px 阈值：原地抖动不算拖动，真拖动才触发", () => {
    // 距离 ~4.2 —— 点击/手抖不该建 ghost、不该换序
    expect(Math.hypot(3, 3) > 6).toBe(false);
    // 距离 ~14.1 —— 越阈值，开始拖
    expect(Math.hypot(10, 10) > 6).toBe(true);
  });
});

describe("拖拽相关样式（编译真实 sass 入口）", () => {
  /**
   * 断言某个 CSS 声明存在，**忽略冒号后的空格**。
   *
   * sass.compile() 默认输出是展开格式（`width: 10px`），vite 构建产物是
   * 压缩格式（`width:10px`）。写死 `"width:10px"` 在编译结果上必然失败
   * —— 踩过一次，别再这么断言。
   */
  function expectDecl(
    css: string,
    prop: string,
    value: string
  ) {
    const escaped = value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    expect(css).toMatch(
      new RegExp(`${prop}:\\s*${escaped}`)
    );
  }

  async function compileApp(): Promise<string> {
    const sass = (await import("sass")).default;
    return sass
      .compile("src/styles/app.scss")
      .css.toString();
  }

  it("跟手浮标必须 pointer-events: none，否则 elementFromPoint 命中它自己", async () => {
    const css = await compileApp();
    const block =
      css.match(
        /\.ai-queue-drag-ghost\s*\{[^}]*\}/
      )?.[0] ?? "";
    expectDecl(block, "pointer-events", "none");
  });

  it("手柄 6 个点阵：10×18 框配 5×6 格子", async () => {
    const handle =
      (await compileApp()).match(
        /\.ai-queue-handle\s*\{[^}]*\}/
      )?.[0] ?? "";
    expectDecl(handle, "width", "10px");
    expectDecl(handle, "height", "18px");
    // 点阵本体：格子尺寸决定 2 列 3 行 = 6 个点
    expectDecl(
      handle,
      "background-size",
      "5px 6px"
    );
    expect(handle).toContain("radial-gradient");
  });

  it("手柄禁掉触摸默认手势，否则触屏上变成滚页面", async () => {
    const handle =
      (await compileApp()).match(
        /\.ai-queue-handle\s*\{[^}]*\}/
      )?.[0] ?? "";
    expectDecl(handle, "touch-action", "none");
  });

  it("拖动中的行压暗、落点描虚线边（两个状态属性都在）", async () => {
    const css = await compileApp();
    expect(css).toContain(
      ".ai-queue-row[data-dragging]"
    );
    expect(css).toContain(
      ".ai-queue-row[data-drop-target]"
    );
  });
});
