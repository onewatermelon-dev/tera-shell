/**
 * shell 集成状态机测试：标记 → 「现在在提示符处 / 命令是什么」。
 *
 * 用一只手写的假终端代替 xterm：只要 `buffer.active` 的
 * getLine/cursorX 与 registerMarker 够用即可，缓冲区内容由测试自己推进，
 * 正好模拟「远端回显到了/没到」两种时序。
 *
 * ⚠️ 时序与生产的对应关系：`feed()` 等价于 xterm parser 在解析到 OSC 时
 * 的回调 —— 那一刻光标就在序列位置，所以 B 之后必须先让缓冲区出现用户
 * 输入，再 feed("C")，和真实顺序一致。
 */

import { describe, expect, it, vi } from "vitest";
import { createShellIntegration } from "@/terminal/lib/shellIntegration/shellIntegration";

/** 构造一只可控的假终端：缓冲区就是一个字符串数组。 */
function fakeTerminal(initial = "") {
  const state = {
    lines: [initial],
    cursorY: 0,
    cursorX: initial.length
  };
  const terminal = {
    buffer: {
      get active() {
        return {
          baseY: 0,
          get cursorY() {
            return state.cursorY;
          },
          get cursorX() {
            return state.cursorX;
          },
          getLine: (row: number) => {
            const text = state.lines[row];
            if (text === undefined)
              return undefined;
            return {
              translateToString: () => text
            };
          }
        };
      }
    },
    registerMarker: vi.fn(() => ({
      line: state.cursorY,
      dispose: vi.fn()
    }))
  };
  /** 模拟用户键入：把文本接到当前行末尾 */
  const type = (text: string) => {
    const row = state.cursorY;
    const current = state.lines[row] ?? "";
    state.lines[row] = current + text;
    state.cursorX = current.length + text.length;
  };
  return { terminal, state, type };
}

describe("shell 集成状态机", () => {
  it("没见过标记时不可用，readInput 为空（调用方据此回退）", () => {
    const { terminal } = fakeTerminal("$ ");
    const integration = createShellIntegration(
      terminal as never
    );
    expect(integration.available).toBe(false);
    expect(integration.readInput()).toBe("");
  });

  it("B 之后进入提示符态，读到的就是用户输入", () => {
    const { terminal, type } = fakeTerminal(
      "terry@host:~$ "
    );
    const integration = createShellIntegration(
      terminal as never
    );
    integration.feed("A");
    integration.feed("B");
    expect(integration.available).toBe(true);
    expect(integration.atPrompt).toBe(true);
    type("ls -l");
    expect(integration.readInput()).toBe("ls -l");
  });

  it("C 时抓到完整命令行，并退出提示符态", () => {
    const { terminal, type } = fakeTerminal("$ ");
    const started: (string | null)[] = [];
    const integration = createShellIntegration(
      terminal as never,
      { onCommandStart: cmd => started.push(cmd) }
    );
    integration.feed("B");
    type("git status --short");
    integration.feed("C");
    expect(started).toEqual([
      "git status --short"
    ]);
    expect(integration.lastCommand()).toBe(
      "git status --short"
    );
    expect(integration.atPrompt).toBe(false);
    expect(integration.running).toBe(true);
  });

  it("D 带回退出码并结束运行态", () => {
    const { terminal } = fakeTerminal("$ ");
    const ended: (number | null)[] = [];
    const integration = createShellIntegration(
      terminal as never,
      { onCommandEnd: code => ended.push(code) }
    );
    integration.feed("C");
    integration.feed("D;exit=130");
    expect(ended).toEqual([130]);
    expect(integration.running).toBe(false);
  });

  it("多行命令逐行拼接，续行提示符被剥掉", () => {
    const { terminal, state } =
      fakeTerminal("$ ");
    const integration = createShellIntegration(
      terminal as never
    );
    integration.feed("B");
    // 第二行起是 PS2 的画法：`> ` + 内容
    state.lines = [
      "$ for i in 1 2",
      "> do echo $i",
      "> done"
    ];
    state.cursorY = 2;
    state.cursorX =
      state.lines[state.cursorY]?.length ?? 0;
    integration.feed("C");
    expect(integration.lastCommand()).toBe(
      "for i in 1 2\ndo echo $i\ndone"
    );
  });

  it("没有 B 时命令文本为空（B 被吃掉也能降级）", () => {
    const { terminal } = fakeTerminal("$ ");
    const started: (string | null)[] = [];
    const integration = createShellIntegration(
      terminal as never,
      { onCommandStart: cmd => started.push(cmd) }
    );
    integration.feed("C");
    expect(started).toEqual([null]);
  });

  it("reset 之后输入起点作废（注入过内容后重定位）", () => {
    const { terminal, type } = fakeTerminal("$ ");
    const integration = createShellIntegration(
      terminal as never
    );
    integration.feed("B");
    expect(integration.atPrompt).toBe(true);
    integration.reset();
    expect(integration.atPrompt).toBe(false);
    type("whatever");
    expect(integration.readInput()).toBe("");
  });

  it("提示符结束位置记录在 B 那一刻", () => {
    const { terminal } = fakeTerminal(
      "user@srv:/tmp$ "
    );
    const integration = createShellIntegration(
      terminal as never
    );
    integration.feed("B");
    expect(integration.promptEnd()).toEqual({
      line: 0,
      column: 15
    });
  });

  it("A 之后回到「不在提示符处」，等下一个 B", () => {
    const { terminal } = fakeTerminal("$ ");
    const integration = createShellIntegration(
      terminal as never
    );
    integration.feed("B");
    integration.feed("C");
    integration.feed("D;exit=0");
    integration.feed("A");
    expect(integration.atPrompt).toBe(false);
    expect(integration.running).toBe(false);
  });

  it("OSC 7 只在目录真的变了时回调（每个提示符都会发一次）", () => {
    const { terminal } = fakeTerminal("$ ");
    const seen: string[] = [];
    const integration = createShellIntegration(
      terminal as never,
      { onCwdChange: cwd => seen.push(cwd) }
    );
    integration.feedCwd("file://host/home/root");
    integration.feedCwd("file://host/home/root");
    integration.feedCwd("file://host/var/log");
    expect(seen).toEqual([
      "/home/root",
      "/var/log"
    ]);
    expect(integration.cwd).toBe("/var/log");
  });

  it("没收到过 OSC 7 时 cwd 为空串（目录栏据此显示等待态）", () => {
    const { terminal } = fakeTerminal("$ ");
    const integration = createShellIntegration(
      terminal as never
    );
    expect(integration.cwd).toBe("");
  });
});
