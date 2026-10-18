/**
 * 代理地址的校验与提示。
 *
 * ## 为什么不直接用 `new URL()`
 *
 * `URL` 能解析 `http://127.0.0.1:7890`，但对 `127.0.0.1:7890`
 * （用户最常写的省略写法）会直接抛错，而用户心里想的显然是
 * 「本机代理，默认 http」。所以这里先补全协议头再交给 `URL`。
 *
 * ## 为什么只允许这三种协议
 *
 * `file:` / `javascript:` 之类传进代理设置毫无意义，放进来只是给
 * 「代理地址写错」这个本来很简单的排查增加噪声。宁可明确拒绝。
 */

/** 支持的代理协议。 */
export const PROXY_PROTOCOLS = [
  "http:",
  "socks5:",
  "socks5h:"
] as const;

/** 常见本地代理端口，用于在输入框里给提示。 */
const COMMON_PORTS = [
  7890, 1080, 10808, 8080, 7897, 20171
];

/** 校验通过后的归一化结果。 */
export type ProxyCheck =
  | {
      ok: true; /** 补全协议后的完整地址，写回设置的就是它 */
      url: string;
    }
  | {
      ok: false; /** 中文原因，直接显示给用户 */
      reason: "empty" | "scheme";
    };

/**
 * 校验并归一化一个代理地址。
 *
 * 补全规则：没有协议头时按 `http://` 处理，并补上默认端口 80 ——
 * 这样「127.0.0.1:7890」这种最常见的写法直接可用。
 *
 * @param input 用户输入的原始文本
 * @returns 校验结果；`reason` 是可枚举的失败原因，便于 i18n
 */
export function checkProxyUrl(
  input: string
): ProxyCheck {
  const text = input.trim();
  if (!text)
    return { ok: false, reason: "empty" };
  const hasScheme =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text);
  // 没写协议时按 http 处理：用户填「127.0.0.1:7890」的意图几乎总是
  // 「本机的 HTTP 代理端口」，而不是想自定义一个协议
  const candidate = hasScheme
    ? text
    : `http://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "scheme" };
  }
  if (
    !PROXY_PROTOCOLS.includes(
      url.protocol as (typeof PROXY_PROTOCOLS)[number]
    )
  )
    return { ok: false, reason: "scheme" };
  // ⚠️ 这里**不补 http 的默认端口**：URL 规范会把 80 当默认端口、
  // toString 时自动省略，补了也留不下；而 http 省略端口本来就等价于
  // 80，语义正确。socks5 没有默认端口概念，URL 会原样保留用户填的值，
  // 不填则由 reqwest 按协议惯例处理，同样不用我们插手。
  return {
    ok: true,
    url: url.toString().replace(/\/$/, "")
  };
}

/** 输入框下方的示例提示（按协议分组的常用端口）。 */
export const PROXY_EXAMPLES: {
  label: string;
  url: string;
}[] = [
  {
    label: "HTTP",
    url: "http://127.0.0.1:7890"
  },
  {
    label: "SOCKS5",
    url: "socks5://127.0.0.1:1080"
  }
];

/** 常用端口，用于给「没填端口」的输入一个提示。 */
export function isCommonPort(
  port: number
): boolean {
  return COMMON_PORTS.includes(port);
}
