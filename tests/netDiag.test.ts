import { describe, expect, it } from "vitest";
import {
  buildDiagCommand,
  DIAG_TOOLS
} from "../src/terminal/components/drawers/NetDiagDrawer";

describe("网络诊断命令构造", () => {
  it("ping：合法目标带 timeout 与计数", () => {
    expect(
      buildDiagCommand("ping", "1.1.1.1")
    ).toBe("timeout 15 ping -c 4 -W 2 1.1.1.1");
  });

  it("端口探测：host:port 拆分走 /dev/tcp", () => {
    expect(
      buildDiagCommand("port", "example.com:443")
    ).toContain("/dev/tcp/example.com/443");
    expect(
      buildDiagCommand("port", "10.0.0.1:22")
    ).toContain("端口 22 ");
  });

  it("端口非法：端口段越界 / 缺冒号返回 null", () => {
    expect(
      buildDiagCommand("port", "host:99999")
    ).toBeNull();
    expect(
      buildDiagCommand("port", "host")
    ).toBeNull();
    expect(
      buildDiagCommand("port", ":443")
    ).toBeNull();
  });

  it("curl：裸域名自动补 https，非法 URL 拒绝", () => {
    expect(
      buildDiagCommand("curl", "example.com/api")
    ).toContain("https://example.com/api");
    expect(
      buildDiagCommand(
        "curl",
        "https://a.com/x?y=1"
      )
    ).toContain("curl -sSI");
  });

  it("注入目标全部拒绝", () => {
    // 命令注入尝试：分号 / 反引号 / $() / 管道
    for (const evil of [
      "1.1.1.1; rm -rf /",
      "a`id`b",
      "$(reboot)",
      "a|b",
      "1.1.1.1 && echo pwned",
      "../etc/passwd"
    ]) {
      expect(
        buildDiagCommand("ping", evil)
      ).toBeNull();
      expect(
        buildDiagCommand("curl", evil)
      ).toBeNull();
    }
  });

  it("空目标拒绝；工具清单完整", () => {
    for (const tool of DIAG_TOOLS) {
      expect(
        buildDiagCommand(tool, "  ")
      ).toBeNull();
    }
    expect(DIAG_TOOLS).toHaveLength(5);
  });
});
