import { describe, it, expect } from "vitest";
import proxySource from "@/settings/components/ProxyRow.tsx?raw";

/**
 * 代理测试结果的**文案不得自相矛盾**。
 *
 * ## 出过什么错
 *
 * 2026-10-18 用户实测看到：
 *
 * > 连接失败已连上：http://127.0.0.1:10808
 *
 * 前端无条件拼「连接失败」+ 后端消息，而后端在「连上了但探测端点返回
 * 非 2xx」时给的消息是「已连上，但目标返回 403」。两句话拼在一起，
 * 同时说「失败」和「已连上」。
 *
 * ## 根因不是文案，是分类丢了
 *
 * 后端把「连不上」和「连上了但状态码不对」都塞进 `Err(String)`，
 * 前端只能拿到一段文本、无法区分，于是套了个统一的前缀。修法是后端
 * 返回结构体（`connected` / `ok` 两个字段），前端分三种情况渲染 ——
 * 这条断言钉的就是「三个 key 各渲染一次、不再有裸的通用前缀」。
 *
 * 为什么单测能抓：这是纯文案拼接问题，tsc / eslint / build 全绿，
 * 只有把「失败前缀 + 后端消息」的拼法固化成断言才拦得住。
 */
describe("代理测试结果文案", () => {
  /** 剥掉注释再匹配 —— 类名与 key 在注释里被大量提及。 */
  const code = proxySource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("失败文案是一个可直接展示的前缀，不再与后端消息拼接", () => {
    // 「连不上：」自带冒号，后端消息直接跟在后面即可；
    // 不含「失败」这类会和后端文本撞车的词
    expect(code).toContain(
      't("proxy.status.fail")'
    );
    // 旧的拼法是 `{t(...)}{test.reason}` 直接相邻两段文本，
    // 现在 reason 走 error 字段且分类判断在前
    expect(code).not.toContain("test.detail");
  });

  it("按 connected 分类渲染，不是一刀切的失败态", () => {
    // connected 为真（哪怕 ok 为假）也要有自己的文案分支
    expect(code).toContain("test.connected");
    expect(code).toContain(
      't("proxy.status.reachable", {'
    );
    expect(code).toContain(
      't("proxy.status.ok", {'
    );
  });

  it("类型里保留 connected 与 ok 两个独立字段", () => {
    expect(code).toContain("connected: boolean");
    expect(code).toContain("ok: boolean");
  });
});
