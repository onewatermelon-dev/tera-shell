/**
 * 聚站（juzong01.me）解析层的纯函数测试。
 *
 * 样本直接来自 2026-11-03 的实抓页面（play 页内嵌的 player_data 一行），
 * 改正则/字段名前先跑这里——它锁的是「网站实际长这样」的事实。
 */
import { describe, expect, it } from "vitest";
import {
  epNumberOf,
  isDirectPlayUrl,
  parsePlayerData
} from "@/anime/lib/juz";

/** 实抓的播放页内嵌配置（voddetail/13384 第 1 集，dyttm3u8 线路）。 */
const REAL_PLAYER_DATA = `<script type="text/javascript">var player_data={"flag":"play","encrypt":0,"trysee":0,"points":0,"link":"\\/vodplay\\/13384-1-1\\/","link_next":"\\/vodplay\\/13384-1-2\\/","link_pre":"","url":"https:\\/\\/vip.dytt-live.com\\/20250913\\/21293_5178db24\\/index.m3u8","url_next":"https:\\/\\/vip.dytt-live.com\\/20250913\\/21280_52222f10\\/index.m3u8","from":"dyttm3u8","server":"no","note":""}</script>`;

describe("聚站播放页 player_data 提取", () => {
  it("实抓样本：抠出明文 m3u8 与下一集路径", () => {
    const parsed = parsePlayerData(
      REAL_PLAYER_DATA
    );
    expect(parsed.playUrl).toBe(
      "https://vip.dytt-live.com/20250913/21293_5178db24/index.m3u8"
    );
    expect(parsed.nextPath).toBe(
      "/vodplay/13384-1-2/"
    );
  });

  it("没有 player_data 时明确报错（而不是静默空串）", () => {
    expect(() =>
      parsePlayerData("<html></html>")
    ).toThrow("播放页解析失败");
  });

  it("加密地址（encrypt≠0）明确拒绝", () => {
    const encrypted = REAL_PLAYER_DATA.replace(
      '"encrypt":0',
      '"encrypt":1'
    );
    expect(() =>
      parsePlayerData(encrypted)
    ).toThrow("加密");
  });
});

describe("播放路径集号解析", () => {
  it("/vodplay/13384-1-12/ → 12", () => {
    expect(
      epNumberOf("/vodplay/13384-1-12/")
    ).toBe(12);
  });

  it("非播放路径 → 0（调用方退回出现顺序）", () => {
    expect(epNumberOf("/vodplay/garbage/")).toBe(
      0
    );
  });
});

describe("可直连地址判定（dujia* 解析源/网页链接要拦下来走换址）", () => {
  it("明文 m3u8/mp4 直链可播", () => {
    expect(
      isDirectPlayUrl(
        "https://vip.dytt-live.com/x/index.m3u8"
      )
    ).toBe(true);
    expect(
      isDirectPlayUrl(
        "http://cdn.example.com/v/jz.mp4"
      )
    ).toBe(true);
  });

  it("加密 token 与网页链接不可直连（实抓形态）", () => {
    expect(
      isDirectPlayUrl(
        "juzong1-96dcU6cQN4a0RvjWpo2C8i5dAa-ICyQgebsJTS9h475t1oWhpsVfnogCGoaAZyVFL2LnCgyWyrUqiicSc3MLBdY8KX5jP3BzaQvtosnNOMTR"
      )
    ).toBe(false);
    expect(
      isDirectPlayUrl(
        "https://v.qq.com/x/cover/mzc0020027yzd9e/m4102pfvc97.html"
      )
    ).toBe(false);
  });
});
