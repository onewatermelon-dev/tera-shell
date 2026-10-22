/**
 * AI 错误翻译：分类、可重试判定、给用户看的文案。
 *
 * 判定顺序错了的后果是误导用户：`insufficient_quota` 若被当成限流，
 * 用户会一直「等几秒再试」而不是去充值 —— 所以顺序也钉住。
 */

import { describe, expect, it } from "vitest";
import type { Translator } from "@/settings/lib/i18n";
import {
  describeAiError,
  parseAiError
} from "@/terminal/lib/ai/aiError";

/** 只关心 key 的假翻译器 */
const t = ((key: string) =>
  key) as unknown as Translator;

/** 用户实际报的那条错误（原样抄自 issue） */
const RATE_LIMIT_JSON =
  'HTTP 429: {"error":{"message":"Channel rate limit reached for model","type":"rate_limit_exceeded","param":null,"code":"rate_limit_exceeded","trace_id":"35bea585"},"request_id":"req_be48"}';

describe("parseAiError", () => {
  it("429 + rate_limit_exceeded → 限流，可重试", () => {
    const error = parseAiError(RATE_LIMIT_JSON);
    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
    // 服务端原话被抠出来（去掉 JSON 包装）
    expect(error.detail).toBe(
      "Channel rate limit reached for model"
    );
    // 原始文本保留给日志
    expect(error.raw).toContain("HTTP 429");
  });

  it("insufficient_quota 优先于 429：额度用尽不可重试", () => {
    const error = parseAiError(
      'HTTP 429: {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'
    );
    expect(error.kind).toBe("quota");
    expect(error.retryable).toBe(false);
  });

  it("401 / 403 归到鉴权", () => {
    expect(
      parseAiError("HTTP 401: unauthorized").kind
    ).toBe("auth");
    expect(
      parseAiError("HTTP 403: forbidden").kind
    ).toBe("auth");
    expect(
      parseAiError(
        "HTTP 400: invalid api key provided"
      ).kind
    ).toBe("auth");
  });

  it("5xx 与服务端异常可重试", () => {
    const error = parseAiError(
      "HTTP 503: upstream unavailable"
    );
    expect(error.kind).toBe("server");
    expect(error.retryable).toBe(true);
  });

  it("网络类错误可重试", () => {
    for (const raw of [
      "error sending request for url",
      "operation timed out",
      "connection refused",
      "dns error"
    ]) {
      const error = parseAiError(raw);
      expect(error.kind).toBe("network");
      expect(error.retryable).toBe(true);
    }
  });

  it("认不出来归 unknown 且不重试", () => {
    const error =
      parseAiError("保存失败：磁盘只读");
    expect(error.kind).toBe("unknown");
    expect(error.retryable).toBe(false);
    expect(error.detail).toBe("");
  });

  it("Error 实例也能解析", () => {
    const error = parseAiError(
      new Error("HTTP 429: rate limit")
    );
    expect(error.kind).toBe("rate_limit");
    expect(error.raw).toContain("Error:");
  });
});

describe("describeAiError", () => {
  it("带服务端原话，不带原始 JSON", () => {
    const text = describeAiError(
      parseAiError(RATE_LIMIT_JSON),
      t
    );
    expect(text).toBe(
      "ai.error.rateLimit（Channel rate limit reached for model）"
    );
    expect(text).not.toContain("trace_id");
    expect(text).not.toContain("{");
  });

  it("没有服务端原话时只说一句话", () => {
    expect(
      describeAiError(parseAiError("HTTP 503"), t)
    ).toBe("ai.error.server");
  });
});
