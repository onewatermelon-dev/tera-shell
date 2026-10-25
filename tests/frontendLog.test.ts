/**
 * 前端日志通道：去重、限流、格式。
 *
 * 这几条规则错了的后果不对称：日志丢了只是少点线索，**限流失效会把
 * 磁盘写满**，所以必须钉住。
 */

import {
  afterEach,
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

/**
 * console 桥接：裸 `console.*` 也要落盘。
 *
 * 这是「终端/控制台里看到的东西都能在日志里找到」的前端一半 ——
 * 项目里大量排查现场直接写的是 `console.debug(...)`，如果不接管，
 * 出事时最想看的那批线索永远进不了诊断包。
 */
describe("console 桥接", () => {
  const originals = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error
  };

  /** 某条消息落盘了几次。 */
  function countOf(needle: string): number {
    return invoke.mock.calls.filter(call =>
      String(call[1]?.message ?? "").includes(
        needle
      )
    ).length;
  }

  afterEach(() => {
    // 桥接是全局副作用：不还原会污染同进程里的其它测试文件
    Object.assign(console, originals);
    delete (
      globalThis as {
        __teraConsoleBridged?: boolean;
      }
    ).__teraConsoleBridged;
  });

  it("裸 console.info 会落盘", async () => {
    const { installConsoleBridge } =
      await freshLog();
    installConsoleBridge();
    console.info("[桥接] 裸 console 探针 A");
    expect(
      countOf("[桥接] 裸 console 探针 A")
    ).toBe(1);
  });

  it("console.debug 以 debug 级别落盘（前端默认放行 debug）", async () => {
    const { installConsoleBridge } =
      await freshLog();
    installConsoleBridge();
    console.debug("[桥接] 裸 console 探针 B");
    const hit = invoke.mock.calls.find(call =>
      String(call[1]?.message ?? "").includes(
        "[桥接] 裸 console 探针 B"
      )
    );
    expect(hit?.[1]?.level).toBe("debug");
  });

  it("console.log 归到 info（大量现场用的是它）", async () => {
    const { installConsoleBridge } =
      await freshLog();
    installConsoleBridge();
    console.log("[桥接] 裸 console 探针 C");
    const hit = invoke.mock.calls.find(call =>
      String(call[1]?.message ?? "").includes(
        "[桥接] 裸 console 探针 C"
      )
    );
    expect(hit?.[1]?.level).toBe("info");
  });

  it("助手不重复落盘：logError 只写一条", async () => {
    const { installConsoleBridge, logError } =
      await freshLog();
    installConsoleBridge();
    logError("[桥接] 助手探针 D");
    expect(countOf("[桥接] 助手探针 D")).toBe(1);
  });

  it("重复安装不会叠加转发（HMR 重载同理）", async () => {
    const { installConsoleBridge } =
      await freshLog();
    installConsoleBridge();
    installConsoleBridge();
    console.info("[桥接] 裸 console 探针 E");
    expect(
      countOf("[桥接] 裸 console 探针 E")
    ).toBe(1);
  });
});
