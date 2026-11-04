/**
 * 动漫 API 客户端：端点路径按逆向结果写死，域名由配置注入。
 *
 * 参考 App 全部走 POST + JSON 包装（{success, message, ...}），
 * 这里保持同构：非 200 或 success=false 统一抛错，错误文本带服务端 message。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ApiEnvelope } from "@/anime/lib/types";

/** 逆向出的端点（参考 App Ktor 服务的相对路径）。 */
export const ENDPOINTS = {
  home: "/api/v1/app/client/home/recommend",
  search: "/api/v1/app/client/video/search",
  detail: "/api/v1/app/client/video/detail",
  episodes: "/api/v1/app/client/resolve/episodes",
  qualities:
    "/api/v1/app/client/resolve/qualities",
  sign: "/api/v1/app/client/resolve/sign",
  exchange: "/api/v1/app/client/resolve/exchange"
} as const;

/**
 * 归一化用户配置的基址：补 scheme、去掉末尾斜杠与路径。
 *
 * ## 为什么不再补 `:7090`
 *
 * 早期按一次抓包写死「参考服务监听 7090」，只要没写端口就无条件补上。
 * 但接口实际是挂在域名 443 / 80 上的，补端口会把**填对的域名**打到一个
 * 不存在的地址，症状是 reqwest 只抛 `error sending request for url (…)`
 * ——看不出是端口错了。现在一律不猜端口：没写就走协议默认端口，
 * 用户自己写了什么就是什么。
 */
export function normalizeBaseUrl(
  input: string
): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error("请先填写 API 地址");
  }
  // 只填了主机（1.2.3.4 或 api.example.com）时按 http 补全，省一次报错
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`API 地址无法解析：${raw}`);
  }
  if (!url.hostname) {
    throw new Error(`API 地址缺少主机名：${raw}`);
  }
  // url.host 自带非默认端口（:7090 会保留，:443 会被 URL 规范化掉）
  return `${url.protocol}//${url.host}`;
}

/**
 * 调一个端点。T 须含 success/message 包装。
 *
 * 网关层错误（4xx/5xx）与服务端业务错误（success=false）都抛 Error，
 * 文本里带上服务端 message —— 弹层红字直接展示。
 */
export async function animeApi<
  T extends ApiEnvelope
>(
  baseUrl: string,
  path: string,
  body: unknown = {}
): Promise<T> {
  const host = normalizeBaseUrl(baseUrl);
  // 走 v3 加密封包：自动协商 + 请求加密 + 响应解密（anime_crypto 仿真层）
  const response = await invoke<{
    status: number;
    body: string;
  }>("anime_api", {
    baseUrl: host,
    path,
    body: body ?? {}
  });
  if (response.status !== 200) {
    throw new Error(
      `服务返回 HTTP ${response.status}`
    );
  }
  let parsed: T;
  try {
    parsed = JSON.parse(response.body) as T;
  } catch {
    throw new Error(
      "响应不是 JSON（域名可能填错，或该地址不是参考 App 的 API）"
    );
  }
  if (parsed.success === false) {
    throw new Error(
      parsed.message || "接口返回失败"
    );
  }
  // v3 解密后的响应是双层包装：{success, message, data:{…业务字段}}。
  // 展开一层，让调用方直接拿 videos/detail/episodes 等业务字段。
  const envelope = parsed as unknown as {
    data?: Record<string, unknown>;
  };
  const inner =
    envelope.data &&
    typeof envelope.data === "object" &&
    !Array.isArray(envelope.data)
      ? envelope.data
      : {};
  return { ...parsed, ...inner } as T;
}
