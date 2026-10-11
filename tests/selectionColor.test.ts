import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";
import {
  resolveColorScheme,
  toSelectionCss,
  COLOR_SCHEMES,
  DEFAULT_COLOR_SCHEME
} from "@/terminal/lib/colorSchemes";

/**
 * 选区色接回配色方案。
 *
 * 背景：iTerm2 配色数据里 463 个方案**全都带选区色**，但项目一直没用 ——
 * xterm 侧把原生选区设成全透明（`toXtermTheme` 写死 `#00000000`），
 * 视觉交给自绘覆盖层，而覆盖层的颜色是写死的「前景色 30% 透明」。
 * 结果是每个方案自己的选区色白下载入了，等于丢掉了配色数据的一半。
 *
 * 这组断言守两件事：
 * 1. 覆盖层用的是变量而不是写死颜色；
 * 2. `toSelectionCss` 一定叠了透明度 —— 直接铺不透明选区色会把字糊掉
 *    （亮色方案配浅灰选区，字符直接看不见）。
 */

describe("选区色：接回配色方案", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  it("覆盖层用 --terminal-selection 变量，不是写死颜色", () => {
    // 编译产物里应能看到这个变量被消费
    expect(css).toContain("--terminal-selection");
  });

  it("覆盖层的 background 不是硬编码的 color-mix", () => {
    // 取出 .terminal-selection-range 的声明块，确认它引用变量
    const escaped = "\\.terminal-selection-range";
    const re = new RegExp(
      `(?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`,
      "g"
    );
    const blocks = [...css.matchAll(re)].map(
      m => m[1] ?? ""
    );
    expect(
      blocks.length,
      "没找到 .terminal-selection-range 的规则"
    ).toBeGreaterThan(0);
    const joined = blocks.join("\n");
    expect(joined).toContain(
      "var(--terminal-selection"
    );
    // ⚠️ 不能只剩一个写死的 color-mix 而不接变量 —— 那等于没接回配色
    const directMix =
      /background:\s*color-mix/.test(joined) &&
      !joined.includes(
        "var(--terminal-selection"
      );
    expect(
      directMix,
      "background 直接写了 color-mix，没接 --terminal-selection"
    ).toBe(false);
  });

  it("搜索命中的红色高亮仍然独立存在（别被选区色吞掉）", () => {
    // 搜索当前项是红色，与鼠标选区是两回事 —— 混淆会让搜索高亮看不出来
    expect(css).toContain(
      ".terminal-selection-range.search"
    );
  });
});

describe("toSelectionCss", () => {
  const scheme = resolveColorScheme(
    DEFAULT_COLOR_SCHEME
  );

  it("有选区色时用选区色，且**必须混 transparent**（不透明色块会遮死文字）", () => {
    const result = toSelectionCss(scheme);
    expect(result).toContain(
      "color-mix(in srgb,"
    );
    expect(result).toContain(
      scheme.selectionBackground
    );
    // ⚠️ 这条是本用例的核心：第二个参数写成背景色会混出不透明色块，
    // 叠在终端文字上字就没了（用户报「划词的时候看不到文字」）
    expect(
      result,
      "第二个参数必须是 transparent，不能是背景色"
    ).toMatch(/,\s*transparent\)$/);
    expect(result).not.toContain(
      scheme.background
    );
  });

  it("任何配色方案算出的表达式都带透明度（不能有不透明色块）", () => {
    // 全 463 套一起验：只要有一套漏了 transparent，那个主题下就看不见字
    for (const s of COLOR_SCHEMES) {
      expect(
        toSelectionCss(s),
        `${s.name} 的选区色不透明，会遮住文字`
      ).toMatch(/,\s*transparent\)$/);
    }
  });

  it("选区色缺失时回退到前景色半透明", () => {
    const fallback = toSelectionCss({
      ...scheme,
      selectionBackground: ""
    });
    expect(fallback).toContain(scheme.foreground);
    expect(fallback).toContain("transparent");
  });

  it("选区色带空白也当缺失处理（手改设置文件可能留空格）", () => {
    const fallback = toSelectionCss({
      ...scheme,
      selectionBackground: "   "
    });
    expect(fallback).toContain("transparent");
  });

  it("全部 463 个方案都能算出合法且带透明度的表达式", () => {
    // 全量验两件事：① 表达式格式合法 ② **必须以 transparent 结尾**。
    // 只要有一套漏了 transparency，那个主题下划词就看不见字 ——
    // 这是真实的线上事故（用户报「划词的时候看不到文字」）
    for (const s of COLOR_SCHEMES) {
      const result = toSelectionCss(s);
      expect(
        result,
        `${s.name} 算出的表达式不合法`
      ).toMatch(/^color-mix\(in srgb, .+\)$/);
      expect(
        result,
        `${s.name} 的选区色不透明，会遮住文字`
      ).toMatch(/,\s*transparent\)$/);
    }
  });

  it("内置默认方案也带选区色（不再走回退）", () => {
    // 原先这里是空串 → 一律回退前景色，等于默认方案没有自己的选区色
    expect(
      scheme.selectionBackground
    ).toBeTruthy();
  });
});
