/**
 * 命令历史（按主机隔离）的纯逻辑测试。
 *
 * 这里钉住的是**安全相关的默认值**，不是普通功能：
 * - 旧格式（无主机信息）的条目绝不能参与补全；
 * - 补全只建议本机跑过的命令 —— 生产机上不该补出测试机的 `rm -rf`。
 */

import { describe, expect, it, vi } from "vitest";
import {
  appendEntry,
  commandsOfHost,
  hostKeyOf,
  markExitCode,
  normalizeHistory,
  searchEntries,
  type CommandHistoryEntry
} from "@/terminal/lib/commandHistory";

// 这些用例只碰纯函数，但模块会 import 存储层（会 invoke）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined)
}));

/** 造一条历史记录。 */
function entry(
  cmd: string,
  host: string,
  at = 0,
  exitCode: number | null = null
): CommandHistoryEntry {
  return { cmd, host, at, exitCode };
}

describe("hostKeyOf", () => {
  it("SSH 会话用 用户@主机:端口 区分", () => {
    expect(
      hostKeyOf({
        kind: "ssh",
        host: "10.0.0.1",
        port: 22,
        username: "root"
      })
    ).toBe("root@10.0.0.1:22");
  });

  it("同机器不同端口算两台（日常会话与测试环境常这样分）", () => {
    const base = {
      kind: "ssh" as const,
      host: "h",
      username: "u"
    };
    expect(
      hostKeyOf({ ...base, port: 22 })
    ).not.toBe(
      hostKeyOf({ ...base, port: 2222 })
    );
  });

  it("本地会话统一记 local", () => {
    expect(
      hostKeyOf({
        kind: "local",
        host: "localhost",
        port: 0,
        username: ""
      })
    ).toBe("local");
  });
});

describe("normalizeHistory（迁移旧格式）", () => {
  it("字符串数组迁移成条目，主机记为未知", () => {
    expect(
      normalizeHistory(["ls", "git status"])
    ).toEqual([
      entry("ls", ""),
      entry("git status", "")
    ]);
  });

  it("丢掉空白与坏数据", () => {
    expect(
      normalizeHistory([
        "   ",
        "",
        42,
        null,
        {
          cmd: "ok",
          host: "h",
          at: 1,
          exitCode: 0
        },
        { cmd: 5 }
      ])
    ).toEqual([entry("ok", "h", 1, 0)]);
  });

  it("非数组输入返回空", () => {
    expect(normalizeHistory(null)).toEqual([]);
    expect(normalizeHistory({})).toEqual([]);
  });

  it("超上限截断（保留最新的）", () => {
    const raw = Array.from(
      { length: 5100 },
      (_, i) => `cmd-${i}`
    );
    const next = normalizeHistory(raw);
    expect(next).toHaveLength(5000);
    expect(next[0]?.cmd).toBe("cmd-100");
  });
});

describe("appendEntry", () => {
  it("同主机同命令去重并挪到末尾", () => {
    const list = [
      entry("a", "h1"),
      entry("b", "h1"),
      entry("a", "h2")
    ];
    const next = appendEntry(
      list,
      entry("a", "h1")
    );
    expect(
      next.map(e => `${e.host}:${e.cmd}`)
    ).toEqual(["h1:b", "h2:a", "h1:a"]);
  });

  it("不同主机的同名命令互不影响", () => {
    const list = [entry("ls", "h1")];
    const next = appendEntry(
      list,
      entry("ls", "h2")
    );
    expect(next).toHaveLength(2);
    expect(commandsOfHost(next, "h1")).toEqual([
      "ls"
    ]);
    expect(commandsOfHost(next, "h2")).toEqual([
      "ls"
    ]);
  });

  it("不改动原数组", () => {
    const list = [entry("a", "h")];
    appendEntry(list, entry("b", "h"));
    expect(list).toHaveLength(1);
  });

  it("超出上限丢最旧的", () => {
    const list = Array.from(
      { length: 5000 },
      (_, i) => entry(`cmd-${i}`, "h")
    );
    const next = appendEntry(
      list,
      entry("newest", "h")
    );
    expect(next).toHaveLength(5000);
    expect(next[0]?.cmd).toBe("cmd-1");
    expect(next[4999]?.cmd).toBe("newest");
  });
});

describe("markExitCode", () => {
  it("回填该主机最近一条没有退出码的记录", () => {
    const list = [
      entry("a", "h", 1),
      entry("b", "h", 2)
    ];
    const next = markExitCode(list, "h", 2);
    expect(next[1]?.exitCode).toBe(2);
    expect(next[0]?.exitCode).toBeNull();
  });

  it("已有退出码的记录不再覆盖（空回车发的 D 不会改上一条）", () => {
    const list = [entry("a", "h", 1, 0)];
    expect(markExitCode(list, "h", 130)).toBe(
      list
    );
  });

  it("别的主机的记录不受影响", () => {
    const list = [entry("a", "h1", 1)];
    expect(markExitCode(list, "h2", 1)).toBe(
      list
    );
  });

  it("没有可回填的记录时返回原数组（调用方据此跳过落盘）", () => {
    const list: CommandHistoryEntry[] = [];
    expect(markExitCode(list, "h", 1)).toBe(list);
  });
});

describe("commandsOfHost（补全数据源）", () => {
  it("⚠️ 只返回本机命令，未知来源的旧条目一概不参与", () => {
    const list = [
      entry("rm -rf /data", ""),
      entry("docker ps", "test@10.0.0.9:22"),
      entry(
        "systemctl restart nginx",
        "root@prod:22"
      )
    ];
    expect(
      commandsOfHost(list, "root@prod:22")
    ).toEqual(["systemctl restart nginx"]);
    expect(
      commandsOfHost(list, "test@10.0.0.9:22")
    ).toEqual(["docker ps"]);
  });

  it("本机没有历史时返回空（退回内置字典兜底）", () => {
    expect(
      commandsOfHost([entry("ls", "h1")], "h2")
    ).toEqual([]);
  });
});

describe("searchEntries（检索面板数据源）", () => {
  const list = [
    entry("git status", "h1", 1, 0),
    entry("docker ps", "h2", 2, 0),
    entry("git push", "h2", 3, 1)
  ];

  it("按时间倒序返回", () => {
    expect(
      searchEntries(list, "").map(e => e.cmd)
    ).toEqual([
      "git push",
      "docker ps",
      "git status"
    ]);
  });

  it("关键词是大小写不敏感的子串匹配", () => {
    expect(
      searchEntries(list, "GIT").map(e => e.cmd)
    ).toEqual(["git push", "git status"]);
  });

  it("可按主机收窄（跨主机搜时不传 host）", () => {
    expect(
      searchEntries(list, "git", "h2").map(
        e => e.cmd
      )
    ).toEqual(["git push"]);
    expect(
      searchEntries(list, "git").map(e => e.cmd)
    ).toEqual(["git push", "git status"]);
  });

  it("无命中返回空", () => {
    expect(
      searchEntries(list, "kubectl")
    ).toEqual([]);
  });
});
