// 「@ 引用终端内容」纯函数层的单测。
//
// 覆盖三件事：
// ① extractTerminalRefs —— 令牌解析（顺序、去重、空白收敛）写错，
//    症状是模型收不到引用或收到错序的快照；
// ② readTerminalLines —— 行范围算错（视口/回滚/选区）是这类功能最
//    容易出的 bug：差一行就会把提示符行漏掉或把回滚截断；
// ③ formatTerminalRefBlock —— 块结构是模型唯一的语义线索。
import { describe, it, expect } from "vitest";
import {
  extractTerminalRefs,
  formatTerminalRefBlock,
  readTerminalLines,
  SCROLLBACK_LINES,
  type TerminalReader
} from "@/terminal/lib/ai/terminalRefs";

/**
 * 假终端读取面：lines 即完整缓冲（下标 = 绝对行号），
 * translateToString 模仿 xterm 的 trimRight 语义。
 */
function fakeReader(
  lines: string[],
  options: {
    rows?: number;
    baseY?: number;
    selection?: string;
  } = {}
): TerminalReader {
  return {
    rows: options.rows ?? lines.length,
    getSelection: () => options.selection ?? "",
    buffer: {
      active: {
        baseY: options.baseY ?? 0,
        getLine: (y: number) => {
          const text = lines[y];
          if (text === undefined)
            return undefined;
          return {
            translateToString: (
              trimRight?: boolean
            ) =>
              trimRight
                ? text.replace(/\s+$/, "")
                : text
          };
        }
      }
    }
  };
}

describe("extractTerminalRefs", () => {
  it("无令牌时原文通过", () => {
    const result =
      extractTerminalRefs("帮我看看这个日志");
    expect(result.text).toBe("帮我看看这个日志");
    expect(result.refs).toEqual([]);
  });

  it("剥离句中的令牌并记下类型", () => {
    const result = extractTerminalRefs(
      "这个报错什么意思 @当前屏幕 帮我看看"
    );
    expect(result.text).toBe(
      "这个报错什么意思 帮我看看"
    );
    expect(result.refs).toEqual([
      { kind: "screen" }
    ]);
  });

  it("多个令牌按文本出现顺序收集", () => {
    const result = extractTerminalRefs(
      "@终端回滚 对比下 @当前屏幕 的差异"
    );
    expect(result.refs).toEqual([
      { kind: "scrollback" },
      { kind: "screen" }
    ]);
    expect(result.text).toBe("对比下 的差异");
  });

  it("同一令牌出现两次记两条", () => {
    const result = extractTerminalRefs(
      "@当前屏幕 和 @当前屏幕"
    );
    expect(result.refs).toEqual([
      { kind: "screen" },
      { kind: "screen" }
    ]);
    expect(result.text).toBe("和");
  });

  it("只有令牌时正文为空", () => {
    const result =
      extractTerminalRefs("@终端回滚");
    expect(result.text).toBe("");
    expect(result.refs).toEqual([
      { kind: "scrollback" }
    ]);
  });

  it("令牌在首尾时不留残空白", () => {
    const result = extractTerminalRefs(
      "  @选中内容  看下  \n"
    );
    expect(result.text).toBe("看下");
    expect(result.refs).toEqual([
      { kind: "selection" }
    ]);
  });

  it("部分匹配的文本不算令牌", () => {
    const result =
      extractTerminalRefs("@当前 屏幕 看看");
    expect(result.text).toBe("@当前 屏幕 看看");
    expect(result.refs).toEqual([]);
  });
});

describe("readTerminalLines", () => {
  const buffer = [
    "行0",
    "行1",
    "行2",
    "行3",
    "行4",
    "行5",
    "行6"
  ];

  it("screen 取视口可见的 rows 行", () => {
    const lines = readTerminalLines(
      fakeReader(buffer, {
        baseY: 2,
        rows: 3
      }),
      "screen"
    );
    expect(lines).toEqual(["行2", "行3", "行4"]);
  });

  it("screen 从缓冲开头算起（没有回滚时）", () => {
    const lines = readTerminalLines(
      fakeReader(buffer, {
        baseY: 0,
        rows: 2
      }),
      "screen"
    );
    expect(lines).toEqual(["行0", "行1"]);
  });

  it("scrollback 总量不足上限时从 0 行全取", () => {
    const lines = readTerminalLines(
      fakeReader(buffer, {
        baseY: 6,
        rows: 1
      }),
      "scrollback"
    );
    expect(lines).toEqual(buffer);
  });

  it("scrollback 超过上限时只取最后 N 行（含视口）", () => {
    // 300 行缓冲 + 视口 3 行 → 只带回滚 200 行
    const big = Array.from(
      { length: 303 },
      (_, i) => `L${i}`
    );
    const lines = readTerminalLines(
      fakeReader(big, {
        baseY: 300,
        rows: 3
      }),
      "scrollback"
    );
    expect(lines).toHaveLength(SCROLLBACK_LINES);
    // 视口最后一行必须在，最早一行被截掉
    expect(lines[lines.length - 1]).toBe("L302");
    expect(lines[0]).toBe("L103");
  });

  it("行内容去右空白", () => {
    const lines = readTerminalLines(
      fakeReader(["有尾空格   ", "  "], {
        rows: 2
      }),
      "screen"
    );
    expect(lines).toEqual(["有尾空格"]);
  });

  it("selection 按行拆分并去尾空白", () => {
    const lines = readTerminalLines(
      fakeReader([], {
        selection: "错误行1  \n错误行2\t"
      }),
      "selection"
    );
    expect(lines).toEqual(["错误行1", "错误行2"]);
  });

  it("selection 无选区时返回空数组", () => {
    const lines = readTerminalLines(
      fakeReader(["x"], {
        selection: ""
      }),
      "selection"
    );
    expect(lines).toEqual([]);
  });
});

describe("formatTerminalRefBlock", () => {
  it("screen 块带标签、行数与正文", () => {
    const block = formatTerminalRefBlock(
      "screen",
      ["第一行", "第二行"]
    );
    expect(block).toContain(
      '<terminal_screen lines="2"'
    );
    expect(block).toContain("视口可见内容");
    expect(block).toContain("第一行\n第二行");
    expect(
      block.endsWith("</terminal_screen>")
    ).toBe(true);
  });

  it("scrollback 块提回滚行数", () => {
    const block = formatTerminalRefBlock(
      "scrollback",
      ["日志"]
    );
    expect(block).toContain(
      "<terminal_scrollback"
    );
    expect(block).toContain(
      `最近 ${SCROLLBACK_LINES} 行`
    );
  });

  it("selection 块用 selection 标签", () => {
    const block = formatTerminalRefBlock(
      "selection",
      ["选中文本"]
    );
    expect(block).toContain(
      "<terminal_selection"
    );
  });

  it("空内容给占位说明而不是空块", () => {
    const block = formatTerminalRefBlock(
      "screen",
      []
    );
    expect(block).toContain("（空）");
    expect(block).not.toContain("lines=");
  });
});
