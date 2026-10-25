import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";

/**
 * 值守弹窗的滚动链（真实回归：2026-10-25 用户报「弹窗无法滚动」）。
 *
 * 弹窗里有 6 个检查项 + 免打扰 + 最近告警，内容比会话弹窗还高。原来的
 * 写法只借了 `.dialog-fields` —— 那只是「字段间距」的类，**不负责滚动**，
 * 于是内容直接把对话框顶出视口，底部按钮和后面的检查项永远看不到。
 *
 * ⚠️ 这里钉的是「谁在滚」这件事。曾经写过一版「让 `.watch-scroll` 用
 * `flex: 1` 撑满 Modal.Body 剩余高度、`max-height: none`」，读起来更聪明，
 * 但弹窗里那层 `<Form>` 渲染出来是裸 `form`（block 元素），`flex: 1`
 * 在其中不生效 —— 结果是高度不受限、滚动条彻底消失，比不写更糟。
 *
 * 光看 tsc / eslint / stylelint 都发现不了：它们只关心「有没有这条属性」，
 * 不关心「这条属性在不在能生效的元素上」。所以编译真实 sass 入口断言。
 */
describe("值守弹窗：滚动链", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /** 取某条选择器的声明块（编译后是展开格式；同选择器可能多块，全拼）。 */
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
    while ((match = re.exec(css)) !== null)
      blocks.push(match[1] ?? "");
    return blocks.join("\n");
  }

  it("对话框限高，否则内容直接长出视口", () => {
    expect(ruleOf(".watch-dialog")).toMatch(
      /max-height:\s*min\(86vh,\s*760px\)/
    );
  });

  it("Body 允许收缩，并提供兜底的纵向滚动", () => {
    const rule = ruleOf(
      ".watch-dialog .modal__body"
    );
    // ⚠️ flex 子项默认可收缩，缺了 min-height: 0 内容照样把限高顶穿
    expect(rule).toMatch(/min-height:\s*0/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
    // 反向回归：写成 overflow: hidden 会把内容裁掉却没有滚动条
    expect(rule).not.toMatch(
      /overflow:\s*hidden/
    );
  });

  it("真正的滚动容器 .dialog-scroll 自带限高与滚动条", () => {
    const rule = ruleOf(".dialog-scroll");
    expect(rule).toMatch(
      /max-height:\s*min\(62vh,\s*540px\)/
    );
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it("不许再把 .dialog-scroll 的限高覆盖成 none", () => {
    // 覆盖成 none 就等于关掉滚动（父级不是 flex，撑不满就换成「无限高」）
    expect(css).not.toMatch(
      /\.watch-scroll[^{]*\{[^}]*max-height:\s*none/
    );
  });
});
