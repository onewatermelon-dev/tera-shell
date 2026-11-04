/**
 * 播放地址提取（src/anime/lib/resolve.ts）的判定用例。
 *
 * 覆盖 resolve/sign 的 data 几种真实形态：TTVideoEngine 字段、
 * 通用 url、嵌套 qualities、Lua 客户端解析源（必须标 clientParse）。
 */
import { describe, expect, it } from "vitest";
import { extractPlay } from "@/anime/lib/resolve";

describe("extractPlay", () => {
  it("识别 main_play_url（TTVideoEngine 口径）", () => {
    const resolved = extractPlay({
      main_play_url:
        "https://cdn.example.com/v.mp4"
    });
    expect(resolved.url).toBe(
      "https://cdn.example.com/v.mp4"
    );
    expect(resolved.clientParse).toBe(false);
  });

  it("优先 play_url，其次嵌套 qualities", () => {
    const direct = extractPlay({
      play_url: "https://a.com/1.mp4",
      playUrl: "https://b.com/2.mp4"
    });
    expect(direct.url).toBe(
      "https://a.com/1.mp4"
    );
    const nested = extractPlay({
      data: {
        qualities: [
          { quality: "720p" },
          { url: "https://c.com/3.m3u8" }
        ]
      }
    });
    expect(nested.url).toBe(
      "https://c.com/3.m3u8"
    );
  });

  it("Lua 客户端解析源标记 clientParse，不把 originalUrl 当直链", () => {
    const resolved = extractPlay({
      isClientParse: true,
      originalUrl: "https://page.example.com/ep1",
      luaScript: "function parse() end"
    });
    // originalUrl 是网页地址不是流地址：无 http 直链时 url=null
    expect(resolved.clientParse).toBe(true);
    expect(resolved.url).toBeNull();
  });

  it("空/异常输入安全返回", () => {
    expect(extractPlay(null)).toEqual({
      url: null,
      clientParse: false,
      quality: undefined
    });
    expect(extractPlay({})).toMatchObject({
      url: null
    });
    expect(
      extractPlay({ url: "" }).url
    ).toBeNull();
  });
});
