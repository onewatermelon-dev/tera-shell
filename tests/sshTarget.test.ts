import { describe, expect, it, vi } from "vitest";
import {
  buildSshTarget,
  execTargetOf
} from "@/sessions/lib/sshTarget";
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
const B = ssh("b", {
  host: "b.example.com",
  password: "enc-b"
});
const C = ssh("c", {
  host: "c.example.com",
  port: 2200,
  username: "jump",
  password: "enc-c"
});

/** 假解密：记录调用参数，返回可读明文。 */
function fakeSecret() {
  return vi.fn(
    async (stored: string) => `plain(${stored})`
  );
}

describe("SSH 连接目标", () => {
  it("直连：默认端口与用户名透传，私钥路径来自参数", async () => {
    const secret = fakeSecret();
    const target = await buildSshTarget(
      { ...A, port: 0, username: "root" },
      [A],
      {
        keyPath: "/home/ops/.ssh/id_ed25519",
        secret
      }
    );
    expect(target).toMatchObject({
      host: "a.example.com",
      port: 22,
      username: "root",
      password: null,
      keyPath: "/home/ops/.ssh/id_ed25519",
      jump: [],
      // 没存过设置时取默认档：与终端 ssh 缺省一致，SFTP/AI
      // 不会因为缺这个字段而变成「拒绝一切新主机」
      hostKeyPolicy: "accept-new"
    });
    expect(secret).not.toHaveBeenCalled();
  });

  it("密码按需解密；空密码传 null（交给私钥 / agent）", async () => {
    const secret = fakeSecret();
    const target = await buildSshTarget(
      { ...A, password: "enc-a" },
      [A],
      { keyPath: "", secret }
    );
    expect(target.password).toBe("plain(enc-a)");
    expect(secret).toHaveBeenCalledWith("enc-a");

    const empty = await buildSshTarget(
      { ...A, password: "" },
      [A],
      { keyPath: "", secret }
    );
    expect(empty.password).toBeNull();
  });

  it("终端启动时传入的明文密码直接使用，不再走解密", async () => {
    const secret = fakeSecret();
    const target = await buildSshTarget(
      { ...A, password: "enc-a" },
      [A],
      {
        keyPath: "",
        secret,
        password: "plain-a"
      }
    );
    expect(target.password).toBe("plain-a");
    expect(secret).not.toHaveBeenCalled();
  });

  it("跳板链离客户端最近的一跳在前，逐跳解密密码", async () => {
    // A 跳 B、B 跳 C ⇒ 物理路径 客户端 → C → B → A
    const chained = { ...B, jumpHostId: "c" };
    const secret = fakeSecret();
    const target = await buildSshTarget(
      { ...A, jumpHostId: "b" },
      [A, chained, C],
      { keyPath: "/k", secret }
    );
    expect(
      target.jump.map(hop => hop.host)
    ).toEqual(["c.example.com", "b.example.com"]);
    expect(target.jump[0]).toMatchObject({
      port: 2200,
      username: "jump",
      password: "plain(enc-c)"
    });
    // B 没配端口，默认 22
    expect(target.jump[1]).toMatchObject({
      port: 22,
      username: "ops",
      password: "plain(enc-b)"
    });
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("跳板会话被删除时退回直连（不把连接堵死）", async () => {
    const target = await buildSshTarget(
      { ...A, jumpHostId: "gone" },
      [A],
      { keyPath: "", secret: fakeSecret() }
    );
    expect(target.jump).toEqual([]);
  });

  it("跳板链成环时退回直连，不会无限递归", async () => {
    const first = { ...A, jumpHostId: "b" };
    const second = { ...B, jumpHostId: "a" };
    const target = await buildSshTarget(
      first,
      [first, second],
      { keyPath: "", secret: fakeSecret() }
    );
    expect(target.jump).toEqual([]);
  });
});

describe("execTargetOf", () => {
  const target = {
    host: "h",
    port: 22,
    username: "u",
    password: null,
    keyPath: "",
    jump: [],
    hostKeyPolicy: "accept-new" as const
  };

  it("取已打开会话上的目标", () => {
    expect(
      execTargetOf({ execTarget: target })
    ).toBe(target);
  });

  it("目标未就绪时给出可读错误", () => {
    expect(() => execTargetOf(undefined)).toThrow(
      /连接信息尚未就绪/
    );
    expect(() => execTargetOf({})).toThrow(
      /连接信息尚未就绪/
    );
  });
});
