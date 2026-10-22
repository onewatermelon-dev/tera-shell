/**
 * 前端日志通道：去重、限流、格式。
 *
 * 这几条规则错了的后果不对称：日志丢了只是少点线索，**限流失效会把
 * 磁盘写满**，所以必须钉住。
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

const invoke = vi.fn(
  (
    _command: string,
    _args?: { level: string; message: string }
  ) => Promise.resolve()
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke
}));

/** 每个用例拿一份全新的模块（去重表是模块级状态） */
async function freshLog() {
  vi.resetModules();
  return await import("@/shared/lib/log");
}

beforeEach(() => {
  invoke.mockClear();
  vi.useRealTimers();
});

describe("logError", () => {
  it("同一条消息在去重窗口内只落盘一次", async () => {
    const { logError } = await freshLog();
    logError("[x] 同一个错误");
    logError("[x] 同一个错误");
    logError("[x] 同一个错误");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "frontend_log",
      {
        level: "error",
        message: "[x] 同一个错误"
      }
    );
  });

  it("不同消息都落盘", async () => {
    const { logError } = await freshLog();
    logError("[x] a");
    logError("[x] b");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("每秒超过预算的条目被丢弃（防止刷爆日志文件）", async () => {
    const { logError } = await freshLog();
    for (let index = 0; index < 120; index += 1) {
      logError(`[x] 第 ${index} 条`);
    }
    // 预算 40 条/秒，加上可能的「被丢弃」提示，不应该接近 120
    expect(invoke.mock.calls.length).toBeLessThan(
      50
    );
  });

  it("Error 格式化成「名字: 消息」（stack 太长不进日志）", async () => {
    const { logError } = await freshLog();
    logError("[x] 失败", new TypeError("boom"));
    const payload = invoke.mock.calls[0]?.[1];
    expect(payload?.message).toContain(
      "TypeError: boom"
    );
    expect(payload?.message).not.toContain("at ");
  });

  it("对象参数被 JSON 序列化，循环引用不抛错", async () => {
    const { logError } = await freshLog();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() =>
      logError("[x]", { a: 1 }, loop)
    ).not.toThrow();
    const payload = invoke.mock.calls[0]?.[1];
    expect(payload?.message).toContain('{"a":1}');
  });
});

describe("level 映射", () => {
  it("warn 与 info 各自带自己的级别", async () => {
    const { logWarn, logInfo } = await freshLog();
    logWarn("[x] 降级");
    logInfo("[x] 动作");
    const levels = invoke.mock.calls.map(
      call => call[1]?.level
    );
    expect(levels).toEqual(["warn", "info"]);
  });
});
