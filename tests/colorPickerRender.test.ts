import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// i18n 用 useSyncExternalStore，SSR 下缺 getServerSnapshot 会抛。
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

/**
 * 回归测试：自定义取色器的触发器**必须真的渲染出来**。
 *
 * 起因是它曾经完全看不见，而 tsc / eslint / stylelint / build 全都通过
 * —— 纯视觉问题只能靠渲染断言兜住。曾经的直接原因：样式选择器写成
 * `.color-custom-trigger.button`，而 HeroUI 的 ColorPicker.Trigger 用的是
 * 裸 RAC Button，渲染出的类名里**没有 `button`**，整条规则失配，
 * 按钮退化成零宽元素。
 */
describe("颜色选择器：自定义取色入口", () => {
  it("渲染出带 color-custom-trigger 的按钮", async () => {
    const { default: ColorPicker } =
      await import("@/sessions/components/ColorPicker");
    const html = renderToStaticMarkup(
      createElement(ColorPicker, {
        value: "",
        onChange: () => {}
      })
    );

    // 触发器在
    expect(html).toContain(
      "color-custom-trigger"
    );
    // 且是真正的 <button>（不是被渲染丢掉的空元素）
    expect(html).toMatch(
      /<button[^>]*color-custom-trigger/
    );
    // 固定色点一个不少：10 个 .color-dot 容器 + 10 个 .color-dot-input。
    // 用 class="color-dot 前缀匹配 —— 选中项的类名是
    // `color-dot is-active`，按 `color-dot"` 精确匹配会漏掉它。
    expect(
      html.match(/class="color-dot[ "]/g)?.length
    ).toBe(10);
    expect(
      html.match(/color-dot-input/g)?.length
    ).toBe(10);
  });

  it("触发器是 color-picker-row 的后代（选择器据此提特异性）", async () => {
    const { default: ColorPicker } =
      await import("@/sessions/components/ColorPicker");
    const html = renderToStaticMarkup(
      createElement(ColorPicker, {
        value: "",
        onChange: () => {}
      })
    );
    const rowAt = html.indexOf(
      "color-picker-row"
    );
    const trigAt = html.indexOf(
      "color-custom-trigger"
    );
    expect(rowAt).toBeGreaterThan(-1);
    expect(trigAt).toBeGreaterThan(rowAt);
  });

  it("选了自定义色后，触发器内圆立刻变成该色", async () => {
    const { default: ColorPicker } =
      await import("@/sessions/components/ColorPicker");
    const html = renderToStaticMarkup(
      createElement(ColorPicker, {
        value: "#ff8800",
        onChange: () => {}
      })
    );
    // 内圆颜色走 CSS 变量传（::before 拿不到父元素的 background）
    expect(html).toContain("--trigger-color");
    expect(html).toContain("#ff8800");
  });

  it("内外圈同色：外圈背景也用同一个变量，不写死彩虹", async () => {
    // 回归：外圈曾写死 conic-gradient，导致选色后只有内圆变、外圈
    // 永远是彩虹，看起来像两个独立元素。
    // 这里直接编译 SCSS 断言产物 —— 比读源文件更接近真实渲染结果。
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss",
      {
        loadPaths: ["src/styles"]
      }
    ).css;
    const at = css.indexOf(
      ".color-picker-row .color-custom-trigger {"
    );
    expect(at).toBeGreaterThan(-1);
    const body = css.slice(
      at,
      css.indexOf("\n}", at)
    );
    // 外圈 background 必须是 var(--trigger-color, …)
    expect(body).toMatch(
      /background:\s*var\(\s*--trigger-color,/
    );
    // 彩虹只能作为该变量的**回落值**出现（在变量之后）
    expect(
      body.indexOf("conic-gradient")
    ).toBeGreaterThan(
      body.indexOf("--trigger-color")
    );
  });

  it("未选自定义色时不写该变量（内圆保持空心）", async () => {
    const { default: ColorPicker } =
      await import("@/sessions/components/ColorPicker");
    const html = renderToStaticMarkup(
      createElement(ColorPicker, {
        value: "red",
        onChange: () => {}
      })
    );
    // "red" 是具名色、不是自定义 hex，不该写 --trigger-color
    expect(html).not.toContain("--trigger-color");
  });

  it("hex 输入框渲染在弹层里且绑定了当前色", async () => {
    // 单独渲染 ColorField 验证（RAC 的 Popover 走 portal，SSR 抓不到）
    const { ColorField, Label } =
      await import("@heroui/react");
    const html = renderToStaticMarkup(
      createElement(
        ColorField,
        {
          value: "#ff8800",
          onChange: () => {}
        } as never,
        createElement(Label, null, "hex"),
        createElement(ColorField.Input, null)
      )
    );
    expect(html).toContain('type="text"');
    //值已绑定（RAC 会把 hex 规范成大写）
    expect(html.toLowerCase()).toContain(
      'value="#ff8800"'
    );
    // label 与 input 正确关联
    expect(html).toMatch(/<label[^>]*for="/);
    expect(html).toMatch(/aria-labelledby=/);
  });

  it("不给通道输入框叠边框（ColorField.Group 自带 border）", async () => {
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss",
      {
        loadPaths: ["src/styles"]
      }
    ).css;
    // 回归：曾给 .color-custom-fields input 手写 border，
    // 与 ColorField.Group 自带的边框叠加 → 每个框都是双边框
    expect(css).not.toContain(
      ".color-custom-fields input"
    );
  });

  it("不覆盖色相滑杆的 grid 布局（否则标签与数值不同列）", async () => {
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss",
      {
        loadPaths: ["src/styles"]
      }
    ).css;
    const at = css.indexOf(
      ".color-custom-slider {"
    );
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(
      at,
      css.indexOf("}", at)
    );
    // .color-slider 靠 grid-template-areas 让 label 与 output 同行、
    // track 独占下一行；改成 flex 会让 grid 区域失效
    expect(block).not.toMatch(/display:\s*flex/);
  });

  it("取色区不被强制高度（否则宽高比被破坏、滑块跑到区域外）", async () => {
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss",
      {
        loadPaths: ["src/styles"]
      }
    ).css;
    const at = css.indexOf(
      ".color-custom-area {"
    );
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(
      at,
      css.indexOf("}", at)
    );
    // HeroUI 的 .color-area 靠 aspect-ratio: 1/1 自成方形，
    // 这里再设 height 就会压扁它，Thumb 位置随之错位
    expect(block).not.toMatch(/height\s*:/);
  });

  it("甜甜圈的分隔线与10 个色点完全一致", async () => {
    // 回归：曾用 `0 0 0 2px var(--surface)` 外扩环，而色点用的是
    // `inset 0 0 0 1px var(--border)` 内侧描边 —— 粗细、颜色、位置
    // 三者都不同，一眼就能看出不是一套。
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss",
      {
        loadPaths: ["src/styles"]
      }
    ).css;
    const grab = (sel: string) => {
      const at = css.indexOf(sel);
      expect(at).toBeGreaterThan(-1);
      const body = css.slice(
        at,
        css.indexOf("}", at)
      );
      // 只留声明部分（去掉选择器行），逐条比对
      return body
        .slice(body.indexOf("{") + 1)
        .split(";")
        .map(s => s.trim())
        .filter(Boolean)
        .filter(
          // background 来源本就不同（色点 inherit，甜甜圈用变量）
          s => !s.startsWith("background")
        )
        .sort();
    };
    expect(
      grab(
        ".color-picker-row .color-custom-trigger::before"
      )
    ).toEqual(grab(".color-dot::before"));
  });

  it("取色面板含取色区、色相滑杆、色彩空间与三通道输入", async () => {
    const sass = (await import("sass")).default;
    const css = sass.compile(
      "src/styles/app.scss",
      {
        loadPaths: ["src/styles"]
      }
    ).css;
    // 面板各区块都要有尺寸/布局，否则会塌掉
    for (const sel of [
      ".color-custom-area",
      ".color-custom-slider",
      ".color-custom-space",
      ".color-custom-fields"
    ]) {
      expect(css).toContain(sel);
    }
    // 通道输入框是三列网格
    expect(css).toMatch(
      /\.color-custom-fields \{[^}]*grid-template-columns:\s*repeat\(3/
    );
  });
});
