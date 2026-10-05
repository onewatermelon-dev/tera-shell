import { describe, expect, it } from "vitest";
import { isBlacklisted } from "../src/terminal/lib/aiChat";

describe("isBlacklisted", () => {
  const list = ["rm", "kill"];
  it("命中首词", () => {
    expect(isBlacklisted("rm -rf /", list)).toBe(
      true
    );
    expect(isBlacklisted("kill 1234", list)).toBe(
      true
    );
  });
  it("跳过 sudo/env 前缀后命中", () => {
    expect(
      isBlacklisted("sudo rm -rf /", list)
    ).toBe(true);
    expect(
      isBlacklisted("env kill 1234", list)
    ).toBe(true);
  });
  it("绝对路径取 basename", () => {
    expect(
      isBlacklisted("/bin/rm -rf /", list)
    ).toBe(true);
  });
  it("不在黑名单的命令放行", () => {
    expect(isBlacklisted("ls -la", list)).toBe(
      false
    );
    expect(isBlacklisted("rmdir x", list)).toBe(
      false
    );
    expect(isBlacklisted("ls", [])).toBe(false);
    expect(isBlacklisted("", list)).toBe(false);
  });
  it("复合命令扫描所有 token", () => {
    expect(
      isBlacklisted(
        "cd /root && rm test.txt",
        list
      )
    ).toBe(true);
    expect(
      isBlacklisted(
        "ls && kill 1 || echo done",
        list
      )
    ).toBe(true);
    expect(
      isBlacklisted('sh -c "rm test.txt"', list)
    ).toBe(true);
    expect(
      isBlacklisted(
        "cd /root; rm -rf x; ls",
        list
      )
    ).toBe(true);
  });
});
