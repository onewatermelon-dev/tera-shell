/**
 * 细滚动条规格的应用范围。
 *
 * 应用内所有原生滚动容器应统一用 `_scrollbar.scss` 的 `thin-scrollbar`
 * mixin（6px 宽 + 3px 全圆角 + 透明轨道），与终端 xterm 自绘滑块观感
 * 一致。浏览器默认的宽灰方角滚动条又宽又抢眼，与终端割裂。
 *
 * 这组断言针对一次真实遗漏：AI 面板、终端区的系统/进程/网络信息抽屉
 * 都 include 了 mixin，唯独 **SFTP 窗口全部漏掉**（双栏文件列表、传输
 * 列表、路径选择面板、底部窗口标签栏），用户报「SFTP 的滚动条样式要跟
 * 系统信息里的一样」。
 *
 * 只断言「用了 mixin」而不逐条抄 CSS 数值 —— 数值变了 mixin 自动跟随，
 * 这里要抓的是「漏了 include」这个回归。
 */

import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";

describe("细滚动条：SFTP 各滚动容器统一用 thin-scrollbar", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /** 取出某条选择器的声明块（含之后所有局部覆盖），与 paneGridLayout 同款。 */
  function ruleOf(selector: string): string {
    const escaped = selector.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    const re = new RegExp(
      `(?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
      "gm"
    );
    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(css)) !== null) {
      blocks.push(match[1] ?? "");
    }
    return blocks.join("\n");
  }

  /**
   * mixin 展开后一定会有 ::-webkit-scrollbar-thumb 规则 ——
   * 编译产物里没有它就说明这个容器没 include。
   */
  function hasThinScrollbar(
    selector: string
  ): boolean {
    const escaped = selector.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    const re = new RegExp(
      `${escaped}[^{]*::-webkit-scrollbar-thumb`,
      "g"
    );
    return re.test(css);
  }

  it("双栏文件列表 .sftp-file-list", () => {
    expect(ruleOf(".sftp-file-list")).toMatch(
      /overflow:\s*auto/
    );
    expect(
      hasThinScrollbar(".sftp-file-list")
    ).toBe(true);
  });

  it("传输列表 .transfer-scroll", () => {
    expect(
      hasThinScrollbar(".transfer-scroll")
    ).toBe(true);
  });

  it("路径选择面板 .path-picker", () => {
    expect(hasThinScrollbar(".path-picker")).toBe(
      true
    );
  });

  it("底部窗口标签栏 .sftp-dock", () => {
    expect(hasThinScrollbar(".sftp-dock")).toBe(
      true
    );
  });

  it("mixin 本体规格没被改坏：6px 宽、3px 圆角、透明轨道", () => {
    // 抓「有没有统一到这个规格」，不锁死具体数值细节
    const thumb =
      /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/g;
    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = thumb.exec(css)) !== null) {
      blocks.push(match[1] ?? "");
    }
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/border-radius:/);
      expect(block).not.toMatch(
        /border-radius:\s*0/
      );
    }
  });

  it("已 include 的参照物仍在（系统信息抽屉 .sys-drawer-body）", () => {
    // 防止「改 SFTP 时误删公共 mixin 的引用」
    expect(
      hasThinScrollbar(".sys-drawer-body")
    ).toBe(true);
  });
});
