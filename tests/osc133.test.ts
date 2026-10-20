/**
 * OSC 133 序列体解析测试。
 *
 * 只测纯函数部分（序列体 → 事件）。分块拼接交给 xterm 的 parser，
 * 不在这一层。
 */

import { describe, expect, it } from "vitest";
import { parseOsc133Event } from "@/terminal/lib/shellIntegration/osc133";

describe("OSC 133 序列体解析", () => {
  it("四个基本标记", () => {
    expect(parseOsc133Event("A")).toEqual({
      kind: "prompt-start"
    });
    expect(parseOsc133Event("B")).toEqual({
      kind: "prompt-end"
    });
    expect(parseOsc133Event("C")).toEqual({
      kind: "command-start"
    });
    expect(parseOsc133Event("D")).toEqual({
      kind: "command-end",
      exitCode: null
    });
  });

  it("退出码支持 exit=N 与裸数字两种写法", () => {
    expect(
      parseOsc133Event("D;exit=130")
    ).toEqual({
      kind: "command-end",
      exitCode: 130
    });
    expect(parseOsc133Event("D;1")).toEqual({
      kind: "command-end",
      exitCode: 1
    });
    expect(parseOsc133Event("D;exit=0")).toEqual({
      kind: "command-end",
      exitCode: 0
    });
  });

  it("未知子命令返回 null（认不出来当没看见）", () => {
    expect(
      parseOsc133Event("P;foo=bar")
    ).toBeNull();
    expect(parseOsc133Event("")).toBeNull();
    expect(parseOsc133Event("A;extra")).toEqual({
      kind: "prompt-start"
    });
  });
});
