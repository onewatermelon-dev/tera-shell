/**
 * HLS 播放列表的 URI 绝对化。
 *
 * ## 为什么要做
 *
 * 播放列表由后端取回后要转成 `blob:` URL 交给 hls.js —— 而 `blob:` 作基址
 * 解析不了相对 URI（片段、密钥、初始化段全都会拼成 blob:xxx/xxx 请求失败）。
 * 所以在交给 hls.js 之前，把列表里每一处 URI 换成绝对地址。
 *
 * 覆盖两种位置：独立行（片段/子列表）与 `#EXT-X-KEY:URI="…"` 这类标签属性。
 */
export function absolutizePlaylist(
  text: string,
  baseUrl: string
): string {
  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith("#")) {
        return resolve(trimmed, baseUrl);
      }
      return line.replace(
        /URI="([^"]*)"/g,
        (_match, uri: string) =>
          `URI="${resolve(uri, baseUrl)}"`
      );
    })
    .join("\n");
}

/** 把单个 URI 解析成绝对地址；已是绝对地址或解析失败原样返回。 */
function resolve(
  uri: string,
  baseUrl: string
): string {
  if (/^(https?:|data:|blob:)/i.test(uri))
    return uri;
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return uri;
  }
}
