import { describe, it, expect } from "vitest";
import {
  base32Decode,
  parseTotpSecret,
  generateTotp,
  totpRemaining
} from "@/sessions/lib/totp";

// RFC 4226 附录 D 的测试密钥 "12345678901234567890"（ASCII）的 Base32
const RFC_SECRET =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// RFC 6238 附录 B（SHA-1，8 位）去掉前两位即为 6 位码：同一截断值
// 对 10^6 取模。前两个向量与 RFC 4226/6238 公布值逐位核对过，
// 后两个用 node 标准库独立重算（覆盖大 counter）。
const VECTORS: [number, string][] = [
  [59_000, "287082"],
  [111_111_110_9000, "081804"],
  [123_456_789_0000, "005924"],
  [2000_000_000_000, "279037"]
];

describe("base32Decode", () => {
  it("标准字母表与 RFC 密钥互转一致", () => {
    expect(
      Array.from(base32Decode(RFC_SECRET) ?? [])
        .map(byte => String.fromCharCode(byte))
        .join("")
    ).toBe("12345678901234567890");
  });

  it("宽容小写、空格 / 连字符分组与尾部填充", () => {
    expect(
      base32Decode(
        "gezd gnbv-gy3t qojq GEZD gnbvgy3tqojq=="
      )
    ).toEqual(base32Decode(RFC_SECRET));
  });

  it("空串与非法字符返回 null", () => {
    expect(base32Decode("")).toBeNull();
    expect(base32Decode("A1B2")).toBeNull();
  });
});

describe("parseTotpSecret", () => {
  it("从 otpauth:// 链接取 secret", () => {
    expect(
      parseTotpSecret(
        "otpauth://totp/ACME:admin%40x?secret=gezdgnbvgy3tqojqgezdgnbvgy3tqojq&issuer=ACME"
      )
    ).toBe(RFC_SECRET);
  });

  it("裸密钥按大写无分隔符归一化", () => {
    expect(
      parseTotpSecret("gezd gnbv-gy3t")
    ).toBe("GEZDGNBVGY3T");
  });

  it("无 secret 参数 / 非法字符 / 空输入返回 null", () => {
    expect(
      parseTotpSecret(
        "otpauth://totp/x?issuer=ACME"
      )
    ).toBeNull();
    expect(parseTotpSecret("abc1ef")).toBeNull();
    expect(parseTotpSecret("   ")).toBeNull();
  });
});

describe("generateTotp", () => {
  for (const [at, expected] of VECTORS) {
    it(`RFC 6238 向量 t=${at}`, async () => {
      expect(
        await generateTotp(RFC_SECRET, at)
      ).toBe(expected);
    });
  }

  it("非法密钥抛错而不是返回假码", async () => {
    await expect(
      generateTotp("abc1ef")
    ).rejects.toThrow();
  });
});

describe("totpRemaining", () => {
  it("窗口内倒数，整窗为 30", () => {
    expect(totpRemaining(59_000)).toBe(1);
    expect(totpRemaining(60_000)).toBe(30);
    expect(totpRemaining(74_000)).toBe(16);
  });
});
