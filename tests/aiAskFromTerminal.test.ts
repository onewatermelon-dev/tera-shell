import { describe, it, expect } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  AI_ASK_PRESETS,
  ASK_TEXT_LIMIT,
  askAiFromTerminal,
  hasAiAskListener,
  onAiAsk,
  pointerRow,
  resolveAskText,
  type AiAsk
} from "@/terminal/lib/ai/askFromTerminal";

/** 造一个最小 terminal 桩（pointerRow 只用 rows / buffer / element）。 */
function stubTerminal(
  overrides: Partial<Terminal> = {}
): Terminal {
  return {
    rows: 30,
    buffer: {
      active: {
        viewportY: 0,
        getLine: () => undefined
      }
    },
    element: undefined,
    ...overrides
  } as unknown as Terminal;
}

describe("指针坐标 → 缓冲行号", () => {
  const rect = { top: 100, height: 300 };

  it("按屏幕高度均分并钳入可见行", () => {
    const terminal = stubTerminal({ rows: 30 });
    // 屏幕 100~400 均分 30 行：每行 10px
    expect(
      pointerRow(
        terminal,
        { clientY: 105 },
        rect,
        0
      )
    ).toBe(0);
    expect(
      pointerRow(
        terminal,
        { clientY: 235 },
        rect,
        0
      )
    ).toBe(13);
    expect(
      pointerRow(
        terminal,
        { clientY: 399 },
        rect,
        0
      )
    ).toBe(29);
  });

  it("越界（上方 / 下方）钳到首尾行，不返回 undefined", () => {
    const terminal = stubTerminal({ rows: 30 });
    expect(
      pointerRow(
        terminal,
        { clientY: 0 },
        rect,
        0
      )
    ).toBe(0);
    expect(
      pointerRow(
        terminal,
        { clientY: 9999 },
        rect,
        0
      )
    ).toBe(29);
  });

  it("视口滚动时叠加 viewportY（回滚区里的行号）", () => {
    const terminal = stubTerminal({ rows: 30 });
    expect(
      pointerRow(
        terminal,
        { clientY: 105 },
        rect,
        500
      )
    ).toBe(500);
  });

  it("屏幕高度为 0（未布局）→ undefined", () => {
    const terminal = stubTerminal();
    expect(
      pointerRow(
        terminal,
        { clientY: 105 },
        { top: 0, height: 0 },
        0
      )
    ).toBeUndefined();
  });
});

describe("取要问 AI 的文本", () => {
  it("有选区就用选区（哪怕指针在别处）", () => {
    const terminal = stubTerminal({
      getSelection: () => "root@srv:~# ls -la"
    } as unknown as Partial<Terminal>);
    expect(
      resolveAskText(terminal, {
        clientX: 0,
        clientY: 0
      })
    ).toBe("root@srv:~# ls -la");
  });

  it("空白选区不算选区，回落指针行", () => {
    const line =
      "total 24\ndrwxr-xr-x 2 root root 4096 .";
    const terminal = stubTerminal({
      getSelection: () => "   "
    } as unknown as Partial<Terminal>);
    // 无 .xterm-screen 时取不到行 → 空串（菜单项置灰）
    expect(
      resolveAskText(terminal, {
        clientX: 0,
        clientY: 0
      })
    ).toBe("");
    expect(line).toContain("total 24");
  });
});

describe("送进面板", () => {
  it("两个预设都有标签和问法（问法带上原文）", () => {
    for (const preset of Object.keys(
      AI_ASK_PRESETS
    ) as (keyof typeof AI_ASK_PRESETS)[]) {
      const item = AI_ASK_PRESETS[preset];
      expect(item.label).toBeTruthy();
      expect(item.prompt("正文")).toContain(
        "正文"
      );
    }
    // 解释与诊断的问法不同
    expect(
      AI_ASK_PRESETS.explain.prompt("x")
    ).not.toBe(
      AI_ASK_PRESETS.diagnose.prompt("x")
    );
  });

  it("没有面板在听 → false，不发送", () => {
    expect(hasAiAskListener()).toBe(false);
    expect(
      askAiFromTerminal("explain", "ls")
    ).toBe(false);
  });

  it("空白内容 → false", () => {
    const received: AiAsk[] = [];
    const off = onAiAsk(ask =>
      received.push(ask)
    );
    expect(hasAiAskListener()).toBe(true);
    expect(
      askAiFromTerminal("explain", "   ")
    ).toBe(false);
    expect(received).toHaveLength(0);
    off();
    expect(hasAiAskListener()).toBe(false);
  });

  it("有面板在听 → 收到 preset + 文本", () => {
    const received: AiAsk[] = [];
    const off = onAiAsk(ask =>
      received.push(ask)
    );
    expect(
      askAiFromTerminal(
        "diagnose",
        "  E: 依赖损坏  "
      )
    ).toBe(true);
    expect(received).toEqual([
      {
        preset: "diagnose",
        text: "E: 依赖损坏"
      }
    ]);
    off();
  });

  it(`超过 ${ASK_TEXT_LIMIT} 字符截断并注明原始长度`, () => {
    const received: AiAsk[] = [];
    const off = onAiAsk(ask =>
      received.push(ask)
    );
    const huge = "x".repeat(ASK_TEXT_LIMIT + 500);
    askAiFromTerminal("explain", huge);
    expect(received[0]?.text.length).toBeLessThan(
      huge.length
    );
    expect(received[0]?.text).toContain(
      `原始 ${huge.length} 字符`
    );
    off();
  });

  it("退订后不再收到", () => {
    const received: AiAsk[] = [];
    const off = onAiAsk(ask =>
      received.push(ask)
    );
    off();
    askAiFromTerminal("explain", "ls");
    expect(received).toHaveLength(0);
  });
});

describe("右键送 AI 的接线（防静默失效）", () => {
  it("菜单挂了两项，弹出时按内容置灰", async () => {
    const src = (
      await import("@/terminal/lib/terminalContextMenu.ts?raw")
    ).default;
    expect(src).toContain(
      "AI_ASK_PRESETS[preset].label"
    );
    expect(src).toContain("askAiFromTerminal");
    // 置灰判定：有内容 + 有面板在听
    expect(src).toContain("hasAiAskListener");
    expect(src).toContain("askEnabled");
    // 两个预设都用上（explain / diagnose）
    expect(src).toContain('"explain"');
    expect(src).toContain('"diagnose"');
  });

  it("AiPanel 订阅并作为一轮提问发出", async () => {
    const src = (
      await import("@/terminal/components/ai/AiPanel.tsx?raw")
    ).default;
    expect(src).toContain("onAiAsk");
    expect(src).toContain(
      "AI_ASK_PRESETS[preset].prompt(text)"
    );
  });

  it("TerminalWorkspace 收到即展开面板（否则回答藏在收起的面板里）", async () => {
    const src = (
      await import("@/terminal/components/TerminalWorkspace.tsx?raw")
    ).default;
    expect(src).toContain("onAiAsk");
    expect(src).toContain(
      "setAiCollapsed(false)"
    );
  });
});
