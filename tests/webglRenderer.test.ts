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

import useTerminalsSource from "@/terminal/lib/session/useTerminals.ts?raw";
import listenersSource from "@/terminal/lib/session/useTerminalGlobalListeners.ts?raw";
import paneOpsSource from "@/terminal/lib/session/useTerminalPaneOps.ts?raw";
import appearanceSource from "@/terminal/lib/session/useTerminalAppearance.ts?raw";
import webglSource from "@/terminal/lib/webglRenderer.ts?raw";
import appHeaderSource from "@/app/components/AppHeader.tsx?raw";
import webglRendererRaw from "@/terminal/lib/webglRenderer.ts?raw";
import settingsSource from "@/settings/lib/settings.ts?raw";
import settingsPageSource from "@/settings/components/SettingsPage.tsx?raw";

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
  const listeners = stripComments(
    listenersSource
  );
  const paneOps = stripComments(paneOpsSource);

  it("关闭会话时先 disableWebgl 再 dispose 终端", () => {
    // 顺序反了：终端先 dispose，addon 会对已销毁的 screenElement 操作。
    // 2026-10-14 拆分后关会话流程搬去了 useTerminalPaneOps
    expect(paneOps).toMatch(
      /disableWebgl\(closing\.terminal\);[\s\S]{0,120}closing\.terminal\.dispose\(\)/
    );
  });

  it("组件卸载时释放全部 WebGL context", () => {
    // 不清会泄漏：context 一直挂着直到达上限，之后新终端全拿不到 WebGL。
    // 2026-10-14 拆分后释放在全局监听的卸载清理里（useTerminalGlobalListeners）
    expect(listeners).toMatch(
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

  /** 取出某条选择器的声明块（编译后是展开格式）。 */
  function ruleOf(selector: string): string {
    const escaped = selector.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    const re = new RegExp(
      `(?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
      "g"
    );
    return [...css.matchAll(re)]
      .map(m => m[1] ?? "")
      .join("\n");
  }

  /**
   * 划词选区必须画在 WebGL canvas **之上**，否则色块会盖住文字
   *（用户报「划词的看不到文字内容了」）。
   *
   * 成因是**子元素顺序**：覆盖层在 createTerminal 时就 append 进
   * `.xterm-screen`，canvas 是 open() 之后才由 addon 加进去 ——
   * 同层级都没 z-index 时，后加入的 canvas 排上面。DOM 渲染器下没有
   * canvas（文字是 HTML 元素），所以之前一直正常。
   */
  it("canvas 有显式 z-index，覆盖层的 z-index 更大", () => {
    const canvasRule = ruleOf(
      ".xterm .xterm-screen canvas"
    );
    const overlayRule = ruleOf(
      ".terminal-selection-overlay"
    );
    // 从声明里抠出 z-index 的数值（正则里的 \s 要转义，用 RegExp 构造避开）
    const zOf = (rule: string): number => {
      const matched = new RegExp(
        "z-index:\\s*(\\d+)"
      ).exec(rule);
      return matched ? Number(matched[1]) : -1;
    };
    expect(
      canvasRule,
      "canvas 没有显式 z-index —— 覆盖层会被它盖住"
    ).toContain("z-index");
    expect(
      zOf(canvasRule),
      "canvas z-index 应为 0"
    ).toBe(0);
    expect(
      zOf(overlayRule),
      "覆盖层 z-index 应为 5"
    ).toBe(5);
    expect(
      zOf(overlayRule),
      "覆盖层 z-index 必须大于 canvas，否则选区遮住文字"
    ).toBeGreaterThan(zOf(canvasRule));
  });

  it("覆盖层仍压在 xterm 自己的 decoration 层之下（ghost text 要能画在选区上）", () => {
    // xterm 的 decoration 是 6/7（见 xterm.css），覆盖层取 5 刚好在下方
    const overlayRule = ruleOf(
      ".terminal-selection-overlay"
    );
    const matched = new RegExp(
      "z-index:\\s*(\\d+)"
    ).exec(overlayRule);
    const overlayZ = matched
      ? Number(matched[1])
      : 99;
    expect(overlayZ).toBeLessThan(6);
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
    // 启用在 useTerminals 的挂载 layout effect；释放在全局监听的
    // 卸载清理（2026-10-14 拆到 useTerminalGlobalListeners）
    expect(code).toContain("enableWebgl");
    expect(
      stripComments(listenersSource)
    ).toContain("disableWebgl");
  });
});

describe("硬件加速开关（设置项）", () => {
  const code = stripComments(useTerminalsSource);
  const webglSource = stripComments(
    webglRendererRaw
  );
  const appearanceCode = stripComments(
    appearanceSource
  );

  it("开关有 setWebglEnabled 入口，且关掉时释放 addon", () => {
    expect(webglSource).toContain(
      "export function setWebglEnabled("
    );
    // 关掉要落到 DOM 渲染器：dispose 每个已启用的 addon
    expect(webglSource).toContain(
      "disposeAll(terminals)"
    );
  });

  it("WeakMap 不可遍历 —— 关开关时终端必须由调用方传入", () => {
    // WeakMap 没有 values()/clear()，遍历会 TS2550/TS2339
    expect(
      webglSource,
      "不该试图遍历 WeakMap"
    ).not.toMatch(
      /webglByTerminal\.(values|clear)\(/
    );
    // 调用处把当前所有会话的 terminal 传了进去。
    // 2026-10-14 拆分后调用处在外观 effect（useTerminalAppearance）
    expect(appearanceCode).toContain(
      "openedRef.current.map(s => s.terminal)"
    );
  });

  it("enableWebgl 尊重开关：关着时不启用", () => {
    expect(webglSource).toMatch(
      /if \(!webglEnabled\) return;/
    );
  });

  it("打开开关后已存在的终端也会补启用（enableWebgl 移出 first 分支）", () => {
    // 在 first 分支里的话，设置里重新打开时老终端不会被补上
    expect(code).toMatch(
      /if \(first\) \{[\s\S]{0,120}mounted = true;[\s\S]{0,40}\}[\s\S]{0,120}enableWebgl\(session\.terminal\);/
    );
    // 该 effect 的依赖里必须带开关
    expect(code).toMatch(
      /appearance\.webglRender[\s\S]{0,40}\]/
    );
  });

  it("设置项默认开（旧数据缺字段时也是开）", () => {
    expect(settingsSource).toMatch(
      /webglRender: true/
    );
    // ⚠️ 必须是 `!== false` 而不是真值判断 —— 真值判断会让
    // 「旧配置里没有这个字段」变成 false，等于给存量用户静默关掉加速
    expect(settingsSource).toContain(
      "webglRender: parsed.webglRender !== false"
    );
  });

  it("设置页有该开关的 UI", () => {
    expect(settingsPageSource).toContain(
      "settings.webgl.title"
    );
    expect(settingsPageSource).toContain(
      "settings.webglRender"
    );
  });
});
