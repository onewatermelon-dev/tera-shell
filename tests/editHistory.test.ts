/**
 * 变更历史（edit_history）纯逻辑测试：主机标识比对、回滚资格判定、
 * 容量上限（50 条截断、超大内容不存原文）。
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  clearData,
  DataName
} from "@/settings/lib/storage";
import {
  canRollback,
  hostKeyOf,
  loadEditHistory,
  recordEditHistory
} from "@/terminal/lib/ai/editHistory";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

/** localStorage 的 node 内存替身（vitest node 环境没有这个全局）。 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) =>
    store.get(key) ?? null,
  setItem: (key: string, value: string) =>
    store.set(key, value),
  removeItem: (key: string) => {
    store.delete(key);
  }
});

// crypto.randomUUID 在 node 20+ 原生可用；保险起见兜一个递增 id
let fakeId = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `id-${(fakeId += 1)}`
});

beforeEach(() => {
  store.clear();
  clearData(DataName.editHistory);
});

/** 构造最小会话：只有 execTarget 与会话名被历史逻辑用到。 */
function sessionOf(
  username: string,
  host: string,
  port: number
): OpenSession {
  return {
    id: "s1",
    name: "测试机",
    execTarget: {
      username,
      host,
      port,
      password: null,
      keyPath: "",
      jumps: []
    }
  } as unknown as OpenSession;
}

describe("hostKeyOf", () => {
  it("拼出 user@host:port", () => {
    expect(
      hostKeyOf({
        username: "root",
        host: "10.0.0.1",
        port: 22
      })
    ).toBe("root@10.0.0.1:22");
  });
});

describe("canRollback", () => {
  const entry = {
    id: "e1",
    time: 0,
    hostKey: "root@10.0.0.1:22",
    sessionName: "测试机",
    path: "/etc/nginx/nginx.conf",
    backupPath: null,
    oldContent: "old",
    newContent: "new",
    added: 1,
    removed: 1,
    rolledBack: false
  };

  it("同主机 + 原文留存 → 可回滚", () => {
    expect(
      canRollback(
        entry,
        sessionOf("root", "10.0.0.1", 22)
      )
    ).toBe(true);
  });

  it("端口不同视为不同目标", () => {
    expect(
      canRollback(
        entry,
        sessionOf("root", "10.0.0.1", 2222)
      )
    ).toBe(false);
  });

  it("已回滚过 / 原文未留存 / 无 exec 通道 → 不可回滚", () => {
    expect(
      canRollback(
        { ...entry, rolledBack: true },
        sessionOf("root", "10.0.0.1", 22)
      )
    ).toBe(false);
    expect(
      canRollback(
        { ...entry, oldContent: null },
        sessionOf("root", "10.0.0.1", 22)
      )
    ).toBe(false);
    expect(canRollback(entry, undefined)).toBe(
      false
    );
  });
});

describe("recordEditHistory", () => {
  it("记录并落盘，最新的在前", () => {
    const session = sessionOf(
      "root",
      "10.0.0.1",
      22
    );
    recordEditHistory({
      session,
      path: "/a.conf",
      oldContent: "one",
      newContent: "two",
      added: 1,
      removed: 1
    });
    recordEditHistory({
      session,
      path: "/b.conf",
      oldContent: "x",
      newContent: "y",
      added: 0,
      removed: 2
    });
    const list = loadEditHistory();
    expect(list).toHaveLength(2);
    expect(list[0]?.path).toBe("/b.conf");
    expect(list[1]?.path).toBe("/a.conf");
    // 远端备份方案已废弃：备份只存本机，字段恒 null
    expect(list[1]?.backupPath).toBeNull();
    expect(list[1]?.hostKey).toBe(
      "root@10.0.0.1:22"
    );
  });

  it("超过 50 条丢最旧的", () => {
    const session = sessionOf(
      "root",
      "10.0.0.1",
      22
    );
    for (let index = 0; index < 52; index += 1) {
      recordEditHistory({
        session,
        path: `/f${index}.conf`,
        oldContent: "a",
        newContent: "b",
        added: 0,
        removed: 0
      });
    }
    const list = loadEditHistory();
    expect(list).toHaveLength(50);
    // 最旧的 f0 / f1 被截掉，最新一条是 f51
    expect(list[0]?.path).toBe("/f51.conf");
    expect(
      list.some(item => item.path === "/f0.conf")
    ).toBe(false);
  });

  it("内容合计超过 128KB 不存原文（记录仍在，不可回滚）", () => {
    const session = sessionOf(
      "root",
      "10.0.0.1",
      22
    );
    const big = "x".repeat(70 * 1024);
    recordEditHistory({
      session,
      path: "/big.conf",
      oldContent: big,
      newContent: big,
      added: 0,
      removed: 0
    });
    const [entry] = loadEditHistory();
    expect(entry?.oldContent).toBeNull();
    expect(entry?.newContent).toBeNull();
    expect(canRollback(entry!, session)).toBe(
      false
    );
  });

  it("本地会话（无 exec 通道）不记录", () => {
    recordEditHistory({
      session: {
        id: "local",
        name: "本地"
      } as OpenSession,
      path: "/a",
      oldContent: "a",
      newContent: "b",
      added: 0,
      removed: 0
    });
    expect(loadEditHistory()).toHaveLength(0);
  });
});
