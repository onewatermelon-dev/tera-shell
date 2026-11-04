/**
 * API 基址归一化（src/anime/lib/client.ts）的判定用例。
 *
 * 重点守住「不要自己猜端口」：历史实现会给没写端口的地址硬补 :7090，
 * 把用户填对的域名打到一个不存在的地址，症状是 reqwest 只说
 * `error sending request` 而看不出是端口错了。
 */
import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "@/anime/lib/client";

describe("normalizeBaseUrl", () => {
  it("https 域名不补端口（走 443）", () => {
    expect(
      normalizeBaseUrl(
        "https://qbfbf.example.com"
      )
    ).toBe("https://qbfbf.example.com");
  });

  it("http 域名不补端口（走 80）", () => {
    expect(
      normalizeBaseUrl("http://api.example.com")
    ).toBe("http://api.example.com");
  });

  it("用户写了端口就原样保留", () => {
    expect(
      normalizeBaseUrl("http://1.2.3.4:7090")
    ).toBe("http://1.2.3.4:7090");
  });

  it("裸主机自动补 http://", () => {
    expect(normalizeBaseUrl("1.2.3.4")).toBe(
      "http://1.2.3.4"
    );
  });

  it("去掉末尾斜杠与多余路径", () => {
    expect(
      normalizeBaseUrl(
        "https://api.example.com/api/v1/"
      )
    ).toBe("https://api.example.com");
  });

  it("空串报错", () => {
    expect(() => normalizeBaseUrl("   ")).toThrow(
      /请先填写/
    );
  });
});
