import {
  describe,
  it,
  expect,
  beforeAll
} from "vitest";

/**
 * 终端卡片的行轨结构。
 *
 * 这组断言针对一次真实回归：拆分从「全局标签条 + 终端」改成
 * 「每窗格自带标签条」后，`.terminal-pane` 的 grid 行数没跟着改，
 * `.pane-grid` 落进了原来的 38px 标签条行 —— 终端被压扁成一条，
 * 底部状态栏被顶到屏幕中间（用户报「内容都看不到了」）。
 *
 * 编译真实 sass 入口断言，光看 tsc / stylelint / vitest 都发现不了。
 */
describe("终端卡片行轨：窗格网格改造后不能退回三行", () => {
  let css: string;

  beforeAll(async () => {
    const sass = (await import("sass")).default;
    css = sass.compile("src/styles/app.scss").css;
  });

  /**
   * 取出某条选择器的声明块（编译后是展开格式）。
   *
   * 同一个选择器可能在文件里出现多次（后面的局部覆盖），所以返回**所有**
   * 命中的块并拼起来 —— 否则断言会随机命中其中一条（实测踩过：
   * `.terminal-host` 的主声明在 _terminal.scss，后面另有一条只改
   * user-select 的覆盖规则，取单条时命中的是后者）。
   */
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

  it("主行轨是「窗格网格 + 状态栏」两行，不是三行", () => {
    const rule = ruleOf(".terminal-pane");
    expect(rule).toMatch(
      /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+25px/
    );
    // 关键回归点：不能再出现 38px 那一行
    expect(rule).not.toMatch(/38px/);
  });

  it("1fr 用 minmax(0, 1fr) 显式收窄，内容再宽也不会撑破卡片", () => {
    // 隐式 auto 会被终端内容反推：内容变宽 → 卡片比窗口宽 → 底部
    // 状态栏被推出可视区（贴右的 SSH / UTF-8 被裁掉）
    const rule = ruleOf(".terminal-pane");
    expect(rule).toMatch(
      /grid-template-rows:[^;]*minmax\(0,\s*1fr\)/
    );
  });

  it("打开信息抽屉时是三行（网格 + 抽屉 + 状态栏），仍无 38px", () => {
    const rule = ruleOf(
      ".terminal-pane.has-sys-drawer"
    );
    expect(rule).toMatch(
      /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+25px/
    );
    expect(rule).not.toMatch(/38px/);
  });

  it("本地会话无状态栏时收为一行", () => {
    const rule = ruleOf(
      ".terminal-pane.no-status"
    );
    expect(rule).toMatch(
      /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*;/
    );
    expect(rule).not.toMatch(/38px/);
  });

  it("专注模式隐藏的是每窗格的 .pane-tabs，不是已删除的 .tabs-bar", () => {
    expect(css).toMatch(
      /\.terminal-focus \.pane-tabs/
    );
    // .tabs-bar 已在窗格改造中删除；专注模式若还指向它就是死规则
    expect(css).not.toMatch(
      /\.terminal-focus \.tabs-bar/
    );
  });

  it("窗格网格自己撑满卡片：flex:1 + min-height:0", () => {
    const rule = ruleOf(".pane-grid");
    // 缺 min-height:0 时 flex 子项会被内容顶破，分隔条被推出可视区
    expect(rule).toMatch(/flex:\s*1/);
    expect(rule).toMatch(/min-height:\s*0/);
  });

  it("终端宿主在窗格内纵向撑满标签条以下的空间", () => {
    const rule = ruleOf(".terminal-host");
    // .pane-cell 是纵向 flex，宿主不给 flex:1 就不会撑开（高度塌成内容）
    expect(rule).toMatch(/flex:\s*1/);
  });

  /**
   * 每条标签条的左右上角都要圆。
   *
   * 之前没有任何 `.pane-tabs` 显式声明圆角 —— 第一格看起来是圆的纯属外层
   * Card（`rounded-xl` + `overflow: hidden`）碰巧裁出来的。上下拆分后下方
   * 那格在网格中间、不贴卡片边，就露成直角，两格观感不一致。
   *
   * ⚠️ 别改成「只给左上角那一格加」（试过，用户反馈更不一致）：这里要的
   * 一致是**每条标签条观感一致**，不是「与卡片圆角对齐」。同理别只圆左边。
   */
  it("每条标签条的左右上角都圆", () => {
    const rule = ruleOf(".pane-tabs");
    expect(rule).toMatch(
      /border-top-left-radius:\s*12px/
    );
    expect(rule).toMatch(
      /border-top-right-radius:\s*12px/
    );
  });

  it("圆角能被横向滚动裁切：标签条 overflow 仍是 auto hidden", () => {
    const rule = ruleOf(".pane-tabs");
    expect(rule).toMatch(
      /overflow:\s*auto\s+hidden/
    );
  });

  it("会话胶囊由容器高度决定，标签条上下不留缝", () => {
    const rule = ruleOf(".pane-tab");
    // 写死 height:32px 时，标签条被压矮的窗格（上下拆分后高度紧张的
    // 下方那格）胶囊会与上边留出空隙，两个窗格的标签对不齐
    expect(rule).toMatch(/align-self:\s*stretch/);
    expect(rule).not.toMatch(/height:\s*32px/);
  });
});
