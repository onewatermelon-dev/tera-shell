/**
 * 多机批量执行纯逻辑测试：黑名单拦截、并发结果的归一化（单台失败不
 * 拖垮整批）、结果 markdown 的表格生成与输出截断。
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

// aiExec 里 invoke 依赖 Tauri 运行时：mock 掉，按用例注入返回值。
// vi.mock 工厂会被提升到模块顶层之前执行，runCommand 必须用 vi.hoisted
// 同步提升，否则工厂闭包拿到的是未初始化的 undefined
const { runCommand, calls } = vi.hoisted(() => ({
  runCommand: vi.fn(),
  calls: [] as unknown[][]
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => {
    calls.push(args);
    return runCommand(...args);
  }
}));

import {
  buildResultMarkdown,
  checkMultiExecBlacklist,
  runOnHosts,
  type MultiExecHost
} from "@/terminal/lib/ai/multiExec";

const host = (
  id: string,
  name = id
): MultiExecHost => ({
  id,
  name,
  target: {
    username: "root",
    host: `${id}.test`,
    port: 22,
    password: null,
    keyPath: "",
    jump: [],
    hostKeyPolicy: "accept-new"
  }
});

// vitest node 环境没有 window：aiExec 执行完会广播目录刷新，stub 掉
vi.stubGlobal("window", {
  dispatchEvent: vi.fn()
});

beforeEach(() => {
  runCommand.mockReset();
  calls.length = 0;
});

describe("checkMultiExecBlacklist", () => {
  it("黑名单命中返回提示，未命中返回 null", () => {
    expect(
      checkMultiExecBlacklist("rm -rf /tmp/x", [
        "rm"
      ])
    ).toContain("黑名单");
    expect(
      checkMultiExecBlacklist("uptime", ["rm"])
    ).toBeNull();
    // 空黑名单不拦
    expect(
      checkMultiExecBlacklist("rm -rf /", [])
    ).toBeNull();
  });
});

describe("runOnHosts", () => {
  it("并发执行并按主机归位结果", async () => {
    // aiRunCommand 调 invoke("ai_run_command", { target: {...target, command} })
    runCommand.mockImplementation(
      (
        _cmd,
        options: {
          target: {
            host: string;
            command: string;
          };
        }
      ) =>
        options.target.command.includes("slow")
          ? Promise.resolve({
              exitCode: 0,
              stdout: "ok",
              stderr: ""
            })
          : Promise.resolve({
              exitCode: 1,
              stdout: "",
              stderr: "denied"
            })
    );
    const results = await runOnHosts(
      [host("a"), host("b")],
      "uptime"
    );
    expect(results).toHaveLength(2);
    expect(
      results.every(
        item => item.ok && item.exitCode === 1
      )
    ).toBe(true);
  });

  it("单台连接失败不拖垮整批，失败项 error 有值", async () => {
    runCommand.mockImplementation(
      (
        _cmd,
        options: { target: { host: string } }
      ) =>
        options.target.host.startsWith("bad")
          ? Promise.reject(
              new Error("connect timeout")
            )
          : Promise.resolve({
              exitCode: 0,
              stdout: "fine",
              stderr: ""
            })
    );
    const results = await runOnHosts(
      [host("bad"), host("good")],
      "uptime"
    );
    expect(results).toHaveLength(2);
    const bad = results.find(
      item => item.id === "bad"
    )!;
    const good = results.find(
      item => item.id === "good"
    )!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain(
      "connect timeout"
    );
    expect(good.ok).toBe(true);
  });

  it("进度回调按完成数上报", async () => {
    runCommand.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: ""
    });
    const seen: number[] = [];
    await runOnHosts(
      [host("a"), host("b"), host("c")],
      "uptime",
      done => seen.push(done)
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("buildResultMarkdown", () => {
  it("生成含命令与逐台状态行的表格", () => {
    const md = buildResultMarkdown("uptime", [
      {
        id: "a",
        name: "web-01",
        ok: true,
        exitCode: 0,
        stdout: "load 0.1",
        stderr: "",
        error: undefined
      },
      {
        id: "b",
        name: "db-01",
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        error: "Error: timeout"
      }
    ]);
    expect(md).toContain("```bash");
    expect(md).toContain("uptime");
    expect(md).toContain(
      "| web-01 | 成功 | 0 | load 0.1 |"
    );
    expect(md).toContain("db-01");
    expect(md).toContain("执行失败");
  });

  it("输出超长截尾部并带省略号", () => {
    const md = buildResultMarkdown(
      "cat big.log",
      [
        {
          id: "a",
          name: "a",
          ok: true,
          exitCode: 0,
          stdout: "x".repeat(3000),
          stderr: "",
          error: undefined
        }
      ]
    );
    expect(md).toContain("…");
  });
});
