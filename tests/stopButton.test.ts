// 「生成中把发送键变成停止键」的渲染契约。
//
// 为什么值得单测：这块回归很难靠肉眼发现 ——
// ① 图标没换、但按钮照样能点，用户以为坏了；
// ② 更糟的是把 busy 混进「按钮是否可用」的判定，于是生成中点它会走 send()
//    路径，消息被静默收进队列，**停止按钮看着在那儿其实从不生效**。
//    tsc / eslint 全绿，只有真机点一下才知道。
//
// 环境说明：本套件跑在 environment: "node"，没有 DOM，所以用
// renderToStaticMarkup 出 HTML 断言字符串（与 colorPickerRender 同思路）。
// CSS module 由 vite 代理成「类名 → 类名」，styles.send 就是 "send"。
import {
  describe,
  it,
  expect,
  vi,
  beforeAll
} from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ComponentType } from "react";

// i18n 用 useSyncExternalStore，SSR 下缺 getServerSnapshot 会抛。
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

let PromptInput: ComponentType<
  Record<string, unknown>
>;

beforeAll(async () => {
  const mod =
    await import("@/terminal/components/aicss/PromptInput");
  PromptInput =
    mod.PromptInput as unknown as ComponentType<
      Record<string, unknown>
    >;
});

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(PromptInput, {
      models: [],
      modelId: "",
      onModelChange: () => {},
      autoExecute: false,
      onAutoExecuteChange: () => {},
      autoApply: false,
      onAutoApplyChange: () => {},
      onOpenBlacklist: () => {},
      images: [],
      onAddImages: () => {},
      onRemoveImage: () => {},
      history: [],
      placeholder: "问点什么",
      onSend: () => {},
      busy: false,
      onStop: () => {},
      ...props
    })
  );
}

/**
 * 取出发送/停止键那个 <button ...> 的起始标签。
 *
 * ⚠️ 不能用 `\bsend\b` 找：CSS module 经 vite 代理后类名带 hash 后缀
 * （`_send_c2bd82`），`_` 是单词字符，`\b` 切不开 —— 早先写成 `\bsend\b`
 * 一个用例都没匹配上。
 */
function sendButton(html: string): string {
  // 末尾的 `>` 不能省：`[^>]*` 只吃到class 属性的 `_send_` 就停了，
  // 后面的 disabled / aria-label 全在匹配范围外，断言会假失败。
  const match = html.match(
    /<button[^>]*_send_[^>]*>/
  );
  expect(
    match,
    "找不到发送/停止键"
  ).not.toBeNull();
  return match?.[0] ?? "";
}

describe("生成中：发送键变停止键", () => {
  it("空闲时是上箭头发送键，没有 data-stop", () => {
    const html = render({});
    const button = sendButton(html);
    expect(button).not.toContain("data-stop");
    expect(button).toContain(
      'aria-label="ai.send"'
    );
    // 上箭头路径（M12 19V5M5 12l7-7 7 7）
    expect(html).toContain("M12 19V5");
  });

  it("busy 时打上 data-stop，图标换成实心方块", () => {
    const html = render({ busy: true });
    const button = sendButton(html);
    expect(button).toContain("data-stop");
    expect(button).toContain(
      'aria-label="ai.stop"'
    );
    expect(button).toContain(
      'title="ai.stopHint"'
    );
    // 方块是**实心**的，所以 fill 而不是 stroke
    expect(html).toContain('fill="currentColor"');
    expect(html).toMatch(/<rect[^>]*width="12"/);
    // 上箭头不再出现
    expect(html).not.toContain("M12 19V5");
  });

  it("busy 时按钮不被禁用 —— 输入框为空也能停", () => {
    // 用户只想中断、手里没草稿时，若这里 disabled 就等于没有停止按钮。
    // 这个坑踩过：把 busy 一起并进 sendActive 的可用性判定就会这样。
    const html = render({ busy: true });
    expect(sendButton(html)).not.toContain(
      "disabled"
    );
  });

  it("空闲且输入为空时禁用（唯一该禁用的组合）", () => {
    const html = render({ busy: false });
    expect(sendButton(html)).toContain(
      "disabled"
    );
  });

  it("busy 时仍能正常渲染编辑区（停止不影响继续打字）", () => {
    // 生成中可以边看边打下一条（进队列），停止键不该把输入区也锁掉。
    // ⚠️ React 渲染出的属性名是驼峰 `contentEditable`（HTML 属性小写化
    // 只发生在真实 DOM 解析时，renderToStaticMarkup 不做这步）。
    const html = render({ busy: true });
    expect(html).toContain(
      'contentEditable="true"'
    );
    expect(html).toContain("问点什么");
  });

  it("等确认阶段同样是停止键（busy 口径已含 pendingCardId）", () => {
    // ⚠️ 这是后来修的那个 bug：`runLoop` 挂起等确认时会主动
    // `setBusy(false)`（否则卡片上的执行/跳过按钮会被自己的 disabled
    // 卡住），于是底部按钮退回发送态 —— 看着能发消息，实际既没有 HTTP
    // 流也没有工具循环在跑，点了什么也不会发生。
    // 现在 AiPanel 传的是 `busy || Boolean(pendingCardId)`，从组件
    // 视角看就是 busy=true，必须给停止图标。
    const html = render({ busy: true });
    const button = sendButton(html);
    expect(button).toContain("data-stop");
    expect(button).toContain(
      'aria-label="ai.stop"'
    );
    expect(html).toMatch(/<rect[^>]*width="12"/);
  });
});
