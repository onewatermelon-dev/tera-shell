import { describe, expect, it } from "vitest";
import { resolveJumpChain } from "@/sessions/lib/jumpHost";
import type { SavedSession } from "@/sessions/lib/session";

/** 造一个 SSH 会话；只覆写用得到的字段。 */
function ssh(
  id: string,
  overrides: Partial<SavedSession> = {}
): SavedSession {
  return {
    id,
    name: id,
    kind: "ssh",
    host: `${id}.example.com`,
    port: 22,
    username: "ops",
    ...overrides
  };
}

const A = ssh("a");
const B = ssh("b");
const C = ssh("c");

describe("跳板链解析", () => {
  it("没配跳板返回 undefined（直连）", () => {
    expect(
      resolveJumpChain(A, [A, B])
    ).toBeUndefined();
  });

  it("单跳：拼 [user@]host 规格，22 端口省略", () => {
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "b" },
        [A, B, C]
      )
    ).toBe("ops@b.example.com");
  });

  it("非默认端口写进规格", () => {
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "b" },
        [A, { ...B, port: 2222 }]
      )
    ).toBe("ops@b.example.com:2222");
  });

  it("链式多跳：首跳在前（ssh 先连最近的跳板）", () => {
    // A 跳 B、B 跳 C ⇒ 先连 C 再连 B，最后落到目标
    const chained = { ...B, jumpHostId: "c" };
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "b" },
        [A, chained, C]
      )
    ).toBe("ops@c.example.com,ops@b.example.com");
  });

  it("成环（含自己跳自己）返回 undefined 而不是死循环", () => {
    // A 跳 B、B 跳 A
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "b" },
        [A, { ...B, jumpHostId: "a" }]
      )
    ).toBeUndefined();
    // 自己跳自己
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "a" },
        [A]
      )
    ).toBeUndefined();
  });

  it("跳板会话已被删除：返回 undefined 走直连", () => {
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "gone" },
        [A]
      )
    ).toBeUndefined();
  });

  it("跳板不是 ssh 会话（本机终端）：返回 undefined", () => {
    const local: SavedSession = {
      id: "local",
      name: "local",
      kind: "local",
      host: "localhost",
      port: 0,
      username: ""
    };
    expect(
      resolveJumpChain(
        { ...A, jumpHostId: "local" },
        [A, local]
      )
    ).toBeUndefined();
  });
});
