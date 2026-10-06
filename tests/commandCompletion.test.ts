/**
 * 命令补全纯逻辑测试：历史匹配、字典兜底、按词接受、历史去重。
 * ghost text 渲染与按键拦截依赖 xterm 实例，不在单测范围。
 */

import { describe, expect, it } from "vitest";
import {
  acceptNextWord,
  BUILTIN_COMMANDS,
  findSuggestion,
  pushCommand
} from "@/terminal/lib/commandCompletion";

describe("findSuggestion", () => {
  const history = [
    "ls",
    "git status",
    "docker ps"
  ];

  it("按历史前缀给出完整建议", () => {
    expect(
      findSuggestion("git st", history)
    ).toBe("git status");
  });

  it("最近用过的优先", () => {
    expect(
      findSuggestion("d", [
        "df -h",
        "docker ps",
        "date"
      ])
    ).toBe("date");
  });

  it("与输入完全相同的历史不算建议", () => {
    expect(
      findSuggestion("ls", history)
    ).toBeNull();
  });

  it("前缀对不上返回 null", () => {
    expect(
      findSuggestion("git pu", history)
    ).toBeNull();
  });

  it("空输入返回 null", () => {
    expect(
      findSuggestion("", history)
    ).toBeNull();
    expect(
      findSuggestion("   ", history)
    ).toBeNull();
  });

  it("历史没有时用内置字典补第一个词", () => {
    expect(findSuggestion("sys", [])).toBe(
      "systemctl"
    );
  });

  it("输入已含空格时不再用字典兜底", () => {
    expect(
      findSuggestion("git st", [])
    ).toBeNull();
  });

  it("输入比字典命令还长时不倒退匹配", () => {
    expect(
      findSuggestion("systemctll", [])
    ).toBeNull();
  });

  it("字典收录常用命令且无重复", () => {
    expect(new Set(BUILTIN_COMMANDS).size).toBe(
      BUILTIN_COMMANDS.length
    );
    expect(BUILTIN_COMMANDS).toContain("docker");
  });
});

describe("acceptNextWord", () => {
  it("按词接受并带上词后空白", () => {
    expect(acceptNextWord(" status -s")).toBe(
      " status "
    );
  });

  it("余量以空白开头时连同空白一起接受", () => {
    expect(acceptNextWord("  --force")).toBe(
      "  --force"
    );
  });

  it("只剩一个词时全部收下", () => {
    expect(acceptNextWord("-s")).toBe("-s");
  });

  it("剩余全是空白时全部收下", () => {
    expect(acceptNextWord("   ")).toBe("   ");
  });

  it("空余量返回空", () => {
    expect(acceptNextWord("")).toBe("");
  });
});

describe("pushCommand", () => {
  it("新命令追加到末尾", () => {
    expect(pushCommand(["a", "b"], "c")).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("重复命令去重并挪到末尾", () => {
    expect(
      pushCommand(["a", "b", "c"], "a")
    ).toEqual(["b", "c", "a"]);
  });

  it("不改动原数组", () => {
    const original = ["a"];
    pushCommand(original, "b");
    expect(original).toEqual(["a"]);
  });

  it("超出上限丢最旧的", () => {
    const history = Array.from(
      { length: 500 },
      (_, i) => `cmd-${i}`
    );
    const next = pushCommand(history, "newest");
    expect(next).toHaveLength(500);
    expect(next[0]).toBe("cmd-1");
    expect(next[499]).toBe("newest");
  });
});
