import { describe, it, expect } from "vitest";
import {
  broadcastTargets,
  type BroadcastCandidate
} from "@/terminal/lib/macro/macroBroadcast";

/**
 * 快捷宏「发送到所有会话标签」的落点选择。
 *
 * ## 为什么这条规则值得单独测
 *
 * 它决定命令下发到哪些会话，是个有分支的业务规则。混在 App.tsx 里
 * （那文件夹着 React + Tauri）就没法单测，而这里的两个分支都对应真实
 * 的线上问题：
 * - 漏发非活动标签 → 「所有标签」名不副实，用户只在当前格看到反应；
 * - 不滤断线 → 后端报「终端会话不存在」，而 App 的错误处理恰好静默
 *   吞掉这句，用户点完看到**零反馈**。
 */
describe("宏广播的落点选择", () => {
  const ssh = (
    id: string
  ): BroadcastCandidate => ({
    id,
    kind: "ssh"
  });
  const local = (
    id: string
  ): BroadcastCandidate => ({
    id,
    kind: "local"
  });

  it("全部已打开的会话都算，不只是当前可见的那只", () => {
    // 场景：左栏开着 a（活动）、拆分右格开着 b，另有 c 在左栏非活动位。
    // 按「窗格当前显示的那只」只会发到 a、b 两个 —— c 被漏掉，
    // 但用户看到的是三个标签，写的是「发送到所有标签」
    const opened = [ssh("a"), ssh("b"), ssh("c")];
    const result = broadcastTargets(
      opened,
      {},
      "a"
    );
    expect(result.ids).toEqual(["a", "b", "c"]);
    expect(result.skipped).toBe(0);
  });

  it("断线的会话被跳过并计数", () => {
    const opened = [ssh("a"), ssh("b"), ssh("c")];
    const result = broadcastTargets(
      opened,
      { b: true },
      "a"
    );
    expect(result.ids).toEqual(["a", "c"]);
    // 跳过的必须计数 —— 反馈里要告诉用户少了几个
    expect(result.skipped).toBe(1);
  });

  it("活动会话即便断线也照发", () => {
    // 它就是用户正看着的那只：静默跳过会让他以为菜单坏了。
    // 真发不出去由后端报错兜底
    const result = broadcastTargets(
      [ssh("a"), ssh("b")],
      { a: true, b: true },
      "a"
    );
    expect(result.ids).toEqual(["a"]);
    expect(result.skipped).toBe(1);
  });

  it("本地会话默认也发（用户可能就写了 dir / ipconfig）", () => {
    const result = broadcastTargets(
      [ssh("a"), local("l")],
      {},
      "a"
    );
    expect(result.ids).toEqual(["a", "l"]);
    expect(result.skipped).toBe(0);
  });

  it("显式排除本地会话时计入 skipped", () => {
    const result = broadcastTargets(
      [ssh("a"), local("l")],
      {},
      "a",
      false
    );
    expect(result.ids).toEqual(["a"]);
    expect(result.skipped).toBe(1);
  });

  it("空列表 → 无落点（菜单里该项应置灰）", () => {
    const result = broadcastTargets([], {}, "a");
    expect(result.ids).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it("全部断线且无活动会话 → 无落点", () => {
    const result = broadcastTargets(
      [ssh("a"), ssh("b")],
      { a: true, b: true },
      undefined
    );
    expect(result.ids).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it("断线表里没有的键算在线（别把 undefined 当 true）", () => {
    const result = broadcastTargets(
      [ssh("a"), ssh("b")],
      { a: false, c: true },
      "a"
    );
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.skipped).toBe(0);
  });

  it("保持 opened 的原顺序（便于日志对照）", () => {
    const result = broadcastTargets(
      [ssh("z"), ssh("m"), ssh("a")],
      {},
      "m"
    );
    expect(result.ids).toEqual(["z", "m", "a"]);
  });

  it("MacroAction 是三分支的 switch，不是 if/else", async () => {
    // ⚠️ 原来只有两个动作时 handleAction 写成
    // `if (edit) ... else delete`，新增第三个若不改 switch，
    // 点「发送到所有标签」会走进 else 把这条宏删掉
    const src = (
      await import("@/terminal/components/macro/MacroBar.tsx?raw")
    ).default;
    const start = src.indexOf(
      "function handleAction"
    );
    expect(start).toBeGreaterThan(-1);
    // ⚠️ 必须从 handleAction 处往后切：文件前面还有 drag 相关的
    // `return () =>`（清理函数），从头切会截到它就 indexOf 返回 -1
    const handler = src.slice(start, start + 700);
    expect(handler).toContain("switch (action)");
    expect(handler).toContain('case "broadcast"');
    expect(handler).toContain('case "delete"');
    // 不能还有 else 分支兜底
    expect(handler).not.toMatch(
      /else\s+onDelete/
    );
  });

  it("菜单项：短文案 + 数量放 title，无落点时置灰", async () => {
    const src = (
      await import("@/terminal/components/macro/MacroContextMenu.tsx?raw")
    ).default;
    expect(src).toContain("broadcastCount");
    expect(src).toContain("broadcastActionHint");
    expect(src).toContain("broadcastEmpty");
    // 置灰走 disabled 属性 —— 样式是 .context-menu-item:disabled，
    // 多写个修饰类不生效
    expect(src).toContain("disabled={disabled}");
    expect(src).not.toContain(
      "context-menu-item--disabled"
    );
    // ⚠️ 数量不能拼进正文：正文一长菜单就被撑宽、整排项跟着变形。
    // 只允许走 title=
    // ⚠️ 从 `renderItem(` 之后开始切：`"broadcast"` 在文件头的
    // MacroAction 联合类型里也出现过一次，从头切会截到 `| '`
    const item = src.slice(
      src.indexOf(
        "renderItem(",
        src.indexOf("MacroContextMenuProps")
      ),
      src.indexOf(
        '"delete"',
        src.indexOf("MacroContextMenuProps")
      )
    );
    expect(item).toContain("title");
    expect(item).not.toMatch(/`\$\{t\(/);
  });

  it("菜单项样式与删除一致（不加粗）", async () => {
    const src = (
      await import("@/terminal/components/macro/MacroContextMenu.tsx?raw")
    ).default;
    // 用 lastIndexOf 定位调用点：`"broadcast"` 在文件头的 MacroAction
    // 联合类型里出现过一次，那个位置没有调用参数可断言
    const item = src.slice(
      src.lastIndexOf('"broadcast"'),
      src.lastIndexOf('"delete"')
    );
    // 编辑是加粗（strong=true）、删除不是。广播跟删除同档 ——
    // 它是写操作但同样不该在视觉上更重
    expect(item).toContain("false");
    expect(item).not.toContain("true");
  });

  it("广播后焦点还给原本那只，不被最后一跳抢走", async () => {
    const src = (
      await import("@/app/components/App.tsx?raw")
    ).default;
    const broadcast = src.slice(
      src.indexOf("function broadcastMacro")
    );
    // ⚠️ runMacro 末尾有 focusTerminal(id)：批量调用会让焦点在最后
    // 一跳结束、且每个 id 都触发一次 focus()，表现为焦点连番跳窜
    expect(broadcast).not.toContain(
      "focusTerminal(id)"
    );
    expect(broadcast).toContain("refocusActive");
    // 关键日志：排查「发了没反应」时看实际落到哪几个
    expect(broadcast).toContain("已广播到");
  });

  it("广播不复用 runMacro（焦点语义不同）", async () => {
    const src = (
      await import("@/app/components/App.tsx?raw")
    ).default;
    const broadcast = src.slice(
      src.indexOf("function broadcastMacro")
    );
    const end = broadcast.indexOf("\n  }");
    const body = broadcast.slice(0, end);
    expect(body).not.toContain("runMacro");
  });

  it("跳过数不为零时要在反馈里说明", async () => {
    const src = (
      await import("@/app/components/App.tsx?raw")
    ).default;
    // 用户以为「发到所有」就是全发了，少了几个却不说，
    // 他会以为是服务器没响应
    expect(src).toContain(
      "macro.broadcastSkipped"
    );
    expect(src).toContain("macro.broadcastNone");
    expect(src).toContain("macro.broadcastDone");
  });

  it("菜单 min-width 撑得下更长的文案", async () => {
    // ⚠️ 走 sass 编译而不是 `?raw`：本项目 scss partial 不支持
    // ?raw 导入（见 paneGridLayout.test.ts 的做法）
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss"
    ).css;
    const rule =
      css.match(
        /\.macro-context-menu\s*\{[^}]*\}/
      )?.[0] ?? "";
    // 曾为塞「发送到所有标签 · 共 5 个会话」把宽度提到 180px。
    // 数量挪进 title 后用不着那么宽 —— 128px 对三项四字文案刚好，
    // 再宽菜单就空得不像话
    expect(rule).toMatch(
      /min-width:\s*1[0-9]{2}px/
    );
    expect(rule).not.toMatch(
      /min-width:\s*1[89][0-9]px/
    );
  });

  it("中英文文案键成对存在", async () => {
    const src = (
      await import("@/settings/lib/i18n.ts?raw")
    ).default;
    for (const key of [
      "macro.broadcastAction",
      "macro.broadcastActionHint",
      "macro.broadcastEmpty",
      "macro.broadcastDone",
      "macro.broadcastNone",
      "macro.broadcastSkipped"
    ]) {
      // zhCN 与 enUS 各一处。⚠️ 匹配要带右引号：`macro.broadcastAction`
      // 会被 `macro.broadcastActionHint` 顺带命中，数出来是 4 不是 2
      const pattern = new RegExp(
        `"${key}":`,
        "g"
      );
      expect(
        (src.match(pattern) ?? []).length,
        `${key} 不是中英各一处`
      ).toBe(2);
    }
  });
});
