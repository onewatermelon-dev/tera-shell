/**
 * 「失败即诊断」的纯逻辑：读输出尾部、拼诊断正文。
 *
 * 这里钉住的是**喂给模型的上下文形状** —— 命令、退出码、输出三段必须
 * 清楚分开，否则模型会把报错当成命令、或者把命令当成输出的一部分。
 */

import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  buildDiagnosisText,
  readRecentOutput,
  type TerminalFailure
} from "@/terminal/lib/failureDiagnosis";

/** 用一组行文本伪造终端缓冲区（只实现本模块用到的部分）。 */
function fakeTerminal(lines: string[]): Terminal {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY: lines.length - 1,
        getLine: (row: number) => {
          const text = lines[row];
          return text === undefined
            ? undefined
            : { translateToString: () => text };
        }
      }
    }
  } as unknown as Terminal;
}

function failure(
  patch: Partial<TerminalFailure> = {}
): TerminalFailure {
  return {
    sessionId: "s1",
    command: "make build",
    exitCode: 2,
    output: "error: missing header",
    at: 0,
    ...patch
  };
}

describe("readRecentOutput", () => {
  it("读缓冲区文本并去掉尾部空行", () => {
    const terminal = fakeTerminal([
      "make: *** [build] Error 2",
      "",
      ""
    ]);
    expect(readRecentOutput(terminal)).toBe(
      "make: *** [build] Error 2"
    );
  });

  it("只取最后 N 行（输出可能几万行）", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `line-${i}`
    );
    const text = readRecentOutput(
      fakeTerminal(lines),
      5
    );
    expect(text.split("\n")).toEqual([
      "line-95",
      "line-96",
      "line-97",
      "line-98",
      "line-99"
    ]);
  });

  it("空缓冲区返回空串", () => {
    expect(
      readRecentOutput(fakeTerminal([]))
    ).toBe("");
  });
});

describe("buildDiagnosisText", () => {
  it("命令、退出码、输出三段分开", () => {
    const text = buildDiagnosisText(failure());
    expect(text).toContain("`make build`");
    expect(text).toContain("退出码 2");
    expect(text).toContain(
      "error: missing header"
    );
    // 输出被包进代码块，模型不会把报错当成命令
    expect(text).toContain("```");
  });

  it("没有输出时明确说明，而不是留白", () => {
    expect(
      buildDiagnosisText(failure({ output: "" }))
    ).toContain("没有捕获到输出");
  });

  it("命令为空（未识别）时也给得出正文", () => {
    const text = buildDiagnosisText(
      failure({ command: "" })
    );
    expect(text).toContain("退出码 2");
  });
});
