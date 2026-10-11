import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";

/**
 * WebGL 渲染器接入。
 *
 * 两个最容易踩的坑，各有一条断言钉住：
 *
 * 1. **`enableWebgl` 必须在 `terminal.open()` 之后调用**。
 *    `WebglAddon.activate()` 要往 `terminal.screenElement` 塞 canvas，
 *    而该元素由 `open()` 创建。提前调用会抛错 —— 在启用失败的
 *    情况下终端连 DOM 渲染器都上不了，整个界面是空的。
 *
 * 2. **必须按终端实例跟踪，不能用单个模块级变量**。
 *    本项目是多窗格布局，同一时刻最多 4 只终端；单个变量会让第 2 只
 *    的启用判定「以为已经启用了」直接 return —— 后面的终端全都悄悄
 *    跑不上 WebGL，而且不报错。
 *
 * 测试用 `?raw` 读源码做静态断言：WebGL addon 依赖真实的 WebGL context，
 * vitest 的 node 环境跑不起来（记忆里记过：本项目测试环境没有 DOM）。
 */

import useTerminalsSource from "@/terminal/lib/useTerminals.ts?raw";
import webglSource from "@/terminal/lib/webglRenderer.ts?raw";
import appHeaderSource from "@/app/components/AppHeader.tsx?raw";

/** 剥掉注释再匹配 —— 类名在注释里被大量提及。 */
const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("WebGL 渲染器：启用时机", () => {
  const code = stripComments(useTerminalsSource);

  it("enableWebgl 在 open() 之后调用", () => {
    // 顺序错了会抛错（screenElement 还没建）→ 终端整个空白
    const openAt = code.indexOf(
      "session.terminal.open(session.element)"
    );
    const webglAt = code.indexOf(
      "enableWebgl(session.terminal)"
    );
    expect(
      openAt,
      "没找到 open() 调用"
    ).toBeGreaterThan(-1);
    expect(
      webglAt,
      "没找到 enableWebgl 调用"
    ).toBeGreaterThan(-1);
    expect(
      webglAt,
      "enableWebgl 必须在 open() 之后"
    ).toBeGreaterThan(openAt);
  });

  it("只在首次挂载时启用（挂在 mounted 判断里）", () => {
    // 每次重渲染都 enableWebgl 会重复 loadAddon → 叠两层 canvas
    expect(code).toMatch(
      /if \(first\) \{[\s\S]{0,200}enableWebgl/
    );
  });
});

describe("WebGL 渲染器：资源清理", () => {
  const code = stripComments(useTerminalsSource);

  it("关闭会话时先 disableWebgl 再 dispose 终端", () => {
    // 顺序反了：终端先 dispose，addon 会对已销毁的 screenElement 操作
    expect(code).toMatch(
      /disableWebgl\(closing\.terminal\);[\s\S]{0,120}closing\.terminal\.dispose\(\)/
    );
  });

  it("组件卸载时释放全部 WebGL context", () => {
    // 不清会泄漏：context 一直挂着直到达上限，之后新终端全拿不到 WebGL
    expect(code).toMatch(
      /for \(const session of openedRef\.current\)[\s\S]{0,80}disableWebgl/
    );
  });
});

describe("webglRenderer 模块", () => {
  const code = stripComments(webglSource);

  it("按终端实例跟踪（不是单个模块级变量）", () => {
    // 单个变量 + 多窗格 = 第 2 只终端永远拿不到 WebGL 且不报错
    expect(code).toContain("WeakMap");
    expect(code).toMatch(
      /webglByTerminal\s*=\s*new WeakMap/
    );
    expect(code).not.toMatch(/^let webgl[!:]/m);
  });

  it("重复调用是幂等的", () => {
    // 二次 loadAddon 会再建一个 canvas，旧的��销毁 → 叠两层画面
    expect(code).toContain(
      "if (webglByTerminal.has(terminal)) return"
    );
  });

  it("处理上下文丢失并降级", () => {
    // context 丢失不抛异常，表现为「一片空白但交互正常」，极难排查
    expect(code).toContain("onContextLoss");
    expect(code).toContain("降级");
  });

  it("启用失败静默降级，不抛错", () => {
    // WebGL 是纯优化：显卡不支持不该让终端打不开
    expect(code).toContain("try {");
    expect(code).toContain("catch");
    // 不该往 onError / setError 之类冒泡
    expect(code).not.toContain("throw");
  });
});

describe("选区覆盖层与 WebGL 的兼容", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /**
   * WebGL 的 canvas 是 `position:absolute` 且**没有 z-index**（auto），
   * 与自绘选区覆盖层同为 `.xterm-screen` 的子元素。谁在上层完全取决于
   * z-index：没有它，覆盖层会被 canvas 盖住 → 鼠标框选看不见高亮。
   *
   * 这条曾是个真实风险点：DOM 渲染器下 `.xterm-rows` 没有定位，
   * 覆盖层靠文档顺序就够；换了 canvas 就必须显式压住。
   */
  it("覆盖层有 z-index，能盖在 WebGL canvas 之上", () => {
    const escaped =
      "\\.terminal-selection-overlay";
    const re = new RegExp(
      `(?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
      "g"
    );
    const blocks = [...css.matchAll(re)].map(
      m => m[1] ?? ""
    );
    expect(
      blocks.length,
      "没找到 .terminal-selection-overlay 的规则"
    ).toBeGreaterThan(0);
    expect(blocks.join("\n")).toMatch(
      /z-index:\s*\d+/
    );
  });

  it("AppHeader 不含 WebGL 相关逻辑（渲染器归 useTerminals 管）", () => {
    expect(
      stripComments(appHeaderSource)
    ).not.toContain("enableWebgl");
  });
});

describe("回归防护：WebGL 未被回退", () => {
  const code = stripComments(useTerminalsSource);

  it("webglRenderer 被真实导入而不是只有文件", () => {
    expect(code).toContain(
      'from "@/terminal/lib/webglRenderer"'
    );
  });

  it("enableWebgl / disableWebgl 都接上了", () => {
    expect(code).toContain("enableWebgl");
    expect(code).toContain("disableWebgl");
  });
});
