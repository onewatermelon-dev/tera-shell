import { describe, it, expect } from "vitest";
import {
  checkProxyUrl,
  isCommonPort,
  PROXY_EXAMPLES
} from "@/settings/lib/proxyUrl";

/**
 * 代理地址校验。
 *
 * 这块逻辑错的表现很隐蔽：地址被"修正"成一个用户没填过的样子（比如
 * 端口被换成 80），用户以为走的是本地 7890 端口，实际连了个不存在的
 * 地址，表现为「AI 就是连不上」这种没法定位的现象。所以归一化规则
 * 逐条钉住。
 */
describe("代理地址校验与归一化", () => {
  it("完整的 http 地址原样通过", () => {
    const result = checkProxyUrl(
      "http://127.0.0.1:7890"
    );
    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:7890"
    });
  });

  it("省略协议时按 http 处理（用户最常见的写法）", () => {
    // 「127.0.0.1:7890」被 new URL() 直接判为非法，但用户心里想的
    // 显然是本机的 http 代理端口
    const result = checkProxyUrl(
      "127.0.0.1:7890"
    );
    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:7890"
    });
  });

  it("socks5 可省略协议头", () => {
    expect(
      checkProxyUrl("127.0.0.1:1080")
    ).toEqual({
      ok: true,
      url: "http://127.0.0.1:1080"
    });
    expect(
      checkProxyUrl("socks5://127.0.0.1:1080")
    ).toEqual({
      ok: true,
      url: "socks5://127.0.0.1:1080"
    });
    // socks5h 是「让代理去做域名解析」的变体，同样放行
    expect(
      checkProxyUrl("socks5h://127.0.0.1:1080").ok
    ).toBe(true);
  });

  it("http 省略端口时不补 80（URL 规范会自动省略）", () => {
    // ⚠️ 这条钉的是「不补」：补了也会被 URL.toString 去掉，
    // 写了反而让人以为补端口这步有效。http 不带端口本来就等价 80
    expect(
      checkProxyUrl("http://127.0.0.1")
    ).toEqual({
      ok: true,
      url: "http://127.0.0.1"
    });
    // socks5 没有默认端口概念，用户填什么就是什么
    expect(
      checkProxyUrl("socks5://127.0.0.1")
    ).toEqual({
      ok: true,
      url: "socks5://127.0.0.1"
    });
  });

  it("保留凭据部分（用户名密码）", () => {
    // 代理软件常有用户名密码，不能在校验时抹掉
    expect(
      checkProxyUrl(
        "http://user:pass@127.0.0.1:7890"
      )
    ).toEqual({
      ok: true,
      url: "http://user:pass@127.0.0.1:7890"
    });
  });

  it("域名形式的代理地址可用", () => {
    expect(
      checkProxyUrl(
        "http://proxy.example.com:8080"
      ).ok
    ).toBe(true);
  });

  it("空输入给出空原因", () => {
    expect(checkProxyUrl("")).toEqual({
      ok: false,
      reason: "empty"
    });
    expect(checkProxyUrl("   ")).toEqual({
      ok: false,
      reason: "empty"
    });
  });

  it("不支持的协议被拒", () => {
    // file: / ftp: 之类传进来毫无意义，放行只会给排查添噪声
    for (const bad of [
      "file:///C:/x",
      "ftp://127.0.0.1:21",
      "javascript:alert(1)"
    ])
      expect(
        checkProxyUrl(bad),
        `${bad} 应被拒绝`
      ).toEqual({
        ok: false,
        reason: "scheme"
      });
  });

  it("只有协议没有主机被拒", () => {
    // 归到 scheme 而非单独一类：URL 解析阶段就失败了，
    // 对用户而言「地址不完整」和「协议不对」都是同一个错
    expect(checkProxyUrl("http://")).toEqual({
      ok: false,
      reason: "scheme"
    });
  });

  it("乱填不抛异常，只给失败原因", () => {
    // 校验函数会被每敲一个字符调用一次，绝不能抛
    for (const bad of [
      "这不是地址",
      "http",
      "://127.0.0.1",
      "%%%",
      "http://[bad"
    ]) {
      const result = checkProxyUrl(bad);
      expect(
        result.ok,
        `${bad} 应有明确结论而非抛错`
      ).toBeTypeOf("boolean");
    }
  });

  it("归一化结果不带尾斜杠", () => {
    // "http://127.0.0.1:7890/" 与不带斜杠是同一个地址，
    // 归一化后统一，避免每次输入都让设置看起来变了
    expect(
      checkProxyUrl("http://127.0.0.1:7890/")
    ).toEqual({
      ok: true,
      url: "http://127.0.0.1:7890"
    });
  });

  it("示例地址自身全部合法", () => {
    // 示例是给用户一键填入的，示例本身不合法就成了笑话
    for (const example of PROXY_EXAMPLES)
      expect(
        checkProxyUrl(example.url).ok,
        `示例 ${example.url} 应合法`
      ).toBe(true);
  });

  it("常用端口判断", () => {
    expect(isCommonPort(7890)).toBe(true);
    expect(isCommonPort(1080)).toBe(true);
    expect(isCommonPort(1234)).toBe(false);
  });
});
