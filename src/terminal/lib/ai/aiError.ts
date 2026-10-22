/**
 * AI 请求失败的翻译层。
 *
 * 后端把 HTTP 失败原样抛出来（`HTTP 429: {"error":{"message":"…"}}`），
 * 以前这坨 JSON 直接甩在界面上 —— 用户看不出该干什么。这里把状态码与
 * 错误类型翻成「能行动的一句话」，原始文本只留在日志里。
 *
 * 判定顺序有讲究：`insufficient_quota` 有时也带 429，必须排在限流**前面**，
 * 否则"额度用尽"会被当成"稍后重试就好"，用户等到天亮也不会好。
 */
import type { Translator } from "@/settings/lib/i18n";

export type AiErrorKind =
  | "quota"
  | "rate_limit"
  | "auth"
  | "server"
  | "network"
  | "unknown";

export type AiError = {
  kind: AiErrorKind;
  /** 值得重试（限流 / 服务端 5xx / 网络抖动） */
  retryable: boolean;
  /** 服务端给出的那句话（已从 JSON 里解出来）；没有就是空串 */
  detail: string;
  /** 原始文本，只进日志 */
  raw: string;
};

const STATUS = /HTTP\s+(\d{3})/;

function toRaw(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

/**
 * 从 `{"error":{"message":"…"}}` 里抠出 message。
 *
 * 反序列化失败就退回原始片段 —— 这句是给人看的，宁可略有转义残留，
 * 也好过整段 JSON。
 */
function extractMessage(raw: string): string {
  const match =
    /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
      raw
    );
  if (!match) return "";
  const body = match[1] ?? "";
  try {
    return String(JSON.parse(`"${body}"`)).trim();
  } catch {
    return body.trim();
  }
}

/** 把后端/HTTP 抛出来的东西翻成可判断的结构。 */
export function parseAiError(
  reason: unknown
): AiError {
  const raw = toRaw(reason);
  const lower = raw.toLowerCase();
  const status = Number(
    STATUS.exec(raw)?.[1] ?? 0
  );
  const detail = extractMessage(raw);

  // 额度用尽：重试没用，得充值或换 key
  if (
    lower.includes("insufficient_quota") ||
    lower.includes(
      "exceeded your current quota"
    ) ||
    lower.includes("余额") ||
    lower.includes("balance")
  ) {
    return {
      kind: "quota",
      retryable: false,
      detail,
      raw
    };
  }

  // 限流：429，或网关用 400 + rate_limit 表达
  if (
    status === 429 ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("rate limit")
  ) {
    return {
      kind: "rate_limit",
      retryable: true,
      detail,
      raw
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return {
      kind: "auth",
      retryable: false,
      detail,
      raw
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      retryable: true,
      detail,
      raw
    };
  }

  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("error sending request") ||
    lower.includes("connection") ||
    lower.includes("dns") ||
    lower.includes("network")
  ) {
    return {
      kind: "network",
      retryable: true,
      detail,
      raw
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    detail,
    raw
  };
}

/** kind → 文案 key（不用模板拼字符串：t 的 key 是字面量联合，拼出来过不了类型） */
const KEY = {
  quota: "ai.error.quota",
  rate_limit: "ai.error.rateLimit",
  auth: "ai.error.auth",
  server: "ai.error.server",
  network: "ai.error.network",
  unknown: "ai.error.unknown"
} as const;

/**
 * 给用户看的一句话。
 *
 * 带上服务端那句原话（比如 `Channel rate limit reached for model`）：
 * 它比"请求失败"有用得多，但不会把整段 JSON 甩出来。
 */
export function describeAiError(
  error: AiError,
  t: Translator
): string {
  const base = t(KEY[error.kind]);
  return error.detail
    ? `${base}（${error.detail}）`
    : base;
}
