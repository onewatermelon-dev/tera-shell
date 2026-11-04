/**
 * HLS 播放列表 URI 绝对化（src/anime/lib/playlist.ts）的判定用例。
 *
 * 背景：后端取回的 m3u8 要转 blob URL 给 hls.js，`blob:` 当基址解析不了
 * 相对 URI，所以必须先把片段/密钥地址换成绝对地址。
 */
import { describe, expect, it } from "vitest";
import { absolutizePlaylist } from "@/anime/lib/playlist";

const BASE =
  "http://cdn.example.com/202611010213/hash/temp/m3u8/1/x.m3u8";

describe("absolutizePlaylist", () => {
  it("绝对片段地址原样保留", () => {
    const text =
      "#EXTM3U\n#EXTINF:6.0,\nhttps://seg.example.com/a.png";
    expect(
      absolutizePlaylist(text, BASE)
    ).toContain("https://seg.example.com/a.png");
  });

  it("相对片段地址按列表地址补全", () => {
    const text = "#EXTM3U\n#EXTINF:6.0,\nseg1.ts";
    expect(
      absolutizePlaylist(text, BASE)
    ).toContain(
      "http://cdn.example.com/202611010213/hash/temp/m3u8/1/seg1.ts"
    );
  });

  it("EXT-X-KEY 里的 URI 属性也补全", () => {
    const text =
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6.0,\nseg1.ts';
    expect(
      absolutizePlaylist(text, BASE)
    ).toContain(
      'URI="http://cdn.example.com/202611010213/hash/temp/m3u8/1/key.bin"'
    );
  });

  it("注释行与非 URI 标签不动", () => {
    const text =
      "#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXTINF:5.96,";
    expect(absolutizePlaylist(text, BASE)).toBe(
      text
    );
  });

  it("已是 blob / data 的地址不再拼接", () => {
    const text = "#EXTM3U\nblob:http://x/abc";
    expect(
      absolutizePlaylist(text, BASE)
    ).toContain("blob:http://x/abc");
  });
});
