/**
 * TOTP（RFC 6238）前端实现：Base32 解码、otpauth:// 链接解析、生成 6 位验证码。
 *
 * 用 WebCrypto 的 HMAC-SHA1，浏览器环境原生支持，零新依赖。
 * 密钥本体（Base32 明文）只在生成的瞬间存在于内存里，持久化的是
 * DPAPI 密文（见 SessionDialog 的 encrypt 落盘）。
 */

/** RFC 4648 标准 Base32 字母表（无 0/1/8/9，避免手抄混淆）。 */
const BASE32_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 30 秒一个窗口、6 位数字：Google Authenticator 等验证器 App 的默认值。 */
const PERIOD_SECONDS = 30;
const DIGITS = 6;

/**
 * Base32 解码；字符集非法返回 null。
 *
 * 宽容处理：大小写混排、空格 / 连字符分隔（验证器 App 展示密钥时
 * 常按 4 位分组）、尾部 `=` 填充都接受。
 */
export function base32Decode(
  input: string
): Uint8Array | null {
  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
  if (!clean) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    // bits 恒 < 13（消费后 < 8），value 不会溢出 32 位，无需掩码
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/**
 * 从用户输入里提取 TOTP 密钥（归一化为大写 Base32）。
 *
 * 接受两种形态：
 * - 验证器 App「导出/设置」里的 `otpauth://totp/...?secret=XXX` 链接；
 * - 裸 Base32 密钥。
 *
 * 返回 null 表示无法识别，调用方展示错误（不允许静默）。
 */
export function parseTotpSecret(
  input: string
): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^otpauth:\/\//i.test(raw)) {
    try {
      // 非特殊 scheme 的 URL：host 是路径里第一段，searchParams 照常可用
      const secret = new URL(
        raw
      ).searchParams.get("secret");
      if (!secret) return null;
      const decoded = base32Decode(secret);
      return decoded?.length
        ? normalize(secret)
        : null;
    } catch {
      return null;
    }
  }
  const decoded = base32Decode(raw);
  return decoded?.length ? normalize(raw) : null;
}

/** 归一化：去分隔符、转大写（不含填充，存储和生成都不需要它）。 */
function normalize(secret: string): string {
  return secret
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
}

/** 当前窗口还剩几秒（倒计时展示用；1~30）。 */
export function totpRemaining(
  at = Date.now()
): number {
  return (
    PERIOD_SECONDS -
    (Math.floor(at / 1000) % PERIOD_SECONDS)
  );
}

/**
 * 生成指定时刻的 6 位验证码。
 *
 * counter 走 8 字节大端（RFC 4226 §5.2）。时间戳毫秒 / 30 在 2^53 内，
 * 高 32 位用除法取、低 32 位用 >>> 截断即可，不需要 BigInt。
 */
export async function generateTotp(
  secret: string,
  at = Date.now()
): Promise<string> {
  const key = base32Decode(secret);
  if (!key?.length)
    throw new Error("TOTP 密钥不是合法的 Base32");

  const counter = Math.floor(
    at / 1000 / PERIOD_SECONDS
  );
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(
    0,
    Math.floor(counter / 2 ** 32)
  );
  view.setUint32(4, counter >>> 0);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      message
    )
  );
  // 动态截断（RFC 4226 §5.3）：末字节（SHA-1 共 20 字节）低 4 位定偏移，
  // 取 4 字节清符号位
  const offset = (mac[19] ?? 0) & 0x0f;
  const code =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(code % 10 ** DIGITS).padStart(
    DIGITS,
    "0"
  );
}
