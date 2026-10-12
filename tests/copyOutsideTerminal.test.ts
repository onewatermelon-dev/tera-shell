import { describe, it, expect } from "vitest";

/**
 * AI 面板划词后能复制（Ctrl+C 不被终端抢走）。
 *
 * ## 现象
 *
 * 用户报「AI 助手中的文字需要能够划词复制」，实测是**划词能选中、
 * 但 Ctrl+C 没反应** —— 划词那半早就好了（`.ai-panel` 一直在
 * `user-select` 白名单里，见 tests/aiSelection.test.ts），坏的是
 * **复制那一下**。
 *
 * ## 根因
 *
 * 全局按键处理挂在 `window` 捕获阶段，而 `copy` 动作的键位是 `Ctrl+C`。
 * 焦点在 AI 面板划词时：
 *
 * 1. `isEditableTarget` 返回 false（普通 div，不是输入控件）→ 不让路；
 * 2. 于是 `Ctrl+C` 被派发给「复制终端选区」这个动作；
 * 3. 而终端那边没有选区 → 写进剪贴板的是**空串**，
 *    同时 `event.preventDefault()` 把浏览器原生复制也一并干掉。
 *
 * 表现就是「选中了但复制不出来」，而且**连报错都没有**。
 *
 * ## 修法
 *
 * 焦点不在终端里时，裸 `Ctrl+C` / `Ctrl+V` 交回浏览器原生处理。
 * 只放行「裸 Ctrl」—— `Ctrl+Shift+C` 这类组合浏览器本来就不处理
 * （某些终端还自己绑了「复制」），一并放行会让用户失去那个键位。
 */

import appHeaderSource from "@/app/components/AppHeader.tsx?raw";

/** 剥掉注释后再匹配 —— 类名在注释里被大量提及。 */
const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("AI 面板划词后能复制：焦点在终端外时放行裸 Ctrl", () => {
  const code = stripComments(appHeaderSource);

  it("全局按键处理在终端之外时放行裸 Ctrl", () => {
    expect(
      code,
      "缺少「焦点在终端外就放行」的判断"
    ).toContain(
      "isOutsideTerminal(event.target) &&"
    );
  });

  it("放行判断在派发动作之前（顺序反了照样被抢）", () => {
    const guardAt = code.indexOf(
      "isOutsideTerminal(event.target) &&"
    );
    const loopAt = code.indexOf(
      "for (const id of Object.keys(shortcuts))"
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(
      guardAt,
      "放行判断必须在动作循环之前"
    ).toBeLessThan(loopAt);
  });

  it("只放行裸 Ctrl，Ctrl+Shift+C 仍归应用", () => {
    // `Ctrl+Shift+C` 浏览器不处理（某些终端还自己绑了复制），
    // 一并放行会让用户失去那个键位。
    // ⚠️ 用正则而不是字符串相等：prettier 会把这行折成两行
    //（`if (...)` 超过 80 列就换行），写成字符串会随格式化失配。
    expect(code).toContain(
      "function isPlainCtrl("
    );
    expect(
      code,
      "isPlainCtrl 少了 shift/alt 的排除"
    ).toMatch(
      /if \(event\.shiftKey \|\| event\.altKey\)(\s|\n)*return false;/
    );
  });

  it("只放行 C 与 V 两个键", () => {
    // 其余 Ctrl 组合（Ctrl+F 查找、Ctrl+Shift+K 清屏…）继续归应用
    expect(code).toMatch(
      /return key === "c" \|\| key === "v";/
    );
  });

  it("终端内判定用 .terminal-instance 祖先（不是「焦点在哪」）", () => {
    // 终端里划词后焦点在 xterm 的辅助 textarea 上；
    // AI 面板里划词焦点落在那个 div —— 只有问「最近的终端宿主」能分开
    expect(code).toContain(
      "function isOutsideTerminal("
    );
    expect(code).toContain(
      'target.closest(".terminal-instance")'
    );
    // xterm 辅助 textarea 要算「内部」
    expect(code).toContain(
      'target.closest(".xterm-helper-textarea")'
    );
  });

  it("target 为 null 时按「在终端外」处理", () => {
    // 个别合成事件没有 target；宁可放行给浏览器原生复制，
    // 也不要抢走用户的复制意图
    expect(code).toContain(
      "if (!(target instanceof HTMLElement))"
    );
  });

  it("KeyLike 形状含 metaKey（mac 的 Cmd+C 同样是复制）", () => {
    expect(code).toContain("metaKey: boolean;");
  });
});

describe("AI 面板划词后能复制：终端内的 Ctrl+C 行为不变", () => {
  const code = stripComments(appHeaderSource);

  it("copy 动作仍在（终端里划词后 Ctrl+C 必须照常工作）", () => {
    // ⚠️ 别为了修 AI 面板把终端复制也一起放掉 ——
    // 终端里划词按 Ctrl+C 是最常用的操作，坏了更严重
    expect(code).toMatch(/copy: \(\) => void;/);
  });

  it("放行判断在「可编辑元素让路」之后", () => {
    // 顺序：录制让路 → 可编辑元素让路 → 菜单打开让路 → 终端外放行 → 派发
    const editableAt = code.indexOf(
      "isEditableTarget(event.target)"
    );
    const guardAt = code.indexOf(
      "isOutsideTerminal(event.target) &&"
    );
    expect(editableAt).toBeGreaterThan(-1);
    expect(
      guardAt,
      "终端外放行要在可编辑元素判断之后"
    ).toBeGreaterThan(editableAt);
  });
});
