/**
 * 发送前脱敏测试：各密钥模式命中、私钥块整段替换、计数与替换一致、
 * 正常文本零误报。
 */

import { describe, expect, it } from "vitest";
import {
  countSecrets,
  redactSecrets
} from "@/terminal/lib/ai/runbook";

describe("redactSecrets", () => {
  it("键值对形式替换为 ***", () => {
    expect(
      redactSecrets(
        "mysql -u root --password=hunter2 -D db"
      )
    ).not.toContain("hunter2");
    expect(
      redactSecrets("API_KEY=abcdef http://x")
    ).toContain("API_KEY=***");
    expect(
      redactSecrets("token: 's3cr3t'")
    ).toContain("token: ***");
  });

  it("Bearer 令牌替换", () => {
    expect(
      redactSecrets(
        "Authorization: Bearer abc123.def456"
      )
    ).toContain("Bearer ***");
  });

  it("私钥块整段替换", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1234567890abcdef",
      "more base64 lines",
      "-----END RSA PRIVATE KEY-----"
    ].join("\n");
    const out = redactSecrets(
      `head\n${pem}\ntail`
    );
    expect(out).not.toContain("MIIEow");
    expect(out).toContain("[已脱敏私钥]");
    expect(out).toContain("head");
    expect(out).toContain("tail");
  });

  it("AWS AccessKey 替换", () => {
    expect(
      redactSecrets(
        "aws key AKIAIOSFODNN7EXAMPLE ok"
      )
    ).toContain("***");
  });

  it("正常文本不受影响（零误报）", () => {
    const plain =
      "df -h 显示根分区 11.6%，uptime 负载 0.25，端口 443 正常监听";
    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe("countSecrets", () => {
  it("计数与替换命中数一致", () => {
    const text =
      "password=abc and token=def and Bearer xyz123";
    // 三个模式各命中一次
    expect(countSecrets(text)).toBe(3);
    expect(countSecrets("uptime")).toBe(0);
  });

  it("私钥块计 1 处", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----";
    expect(countSecrets(pem)).toBe(1);
  });
});
