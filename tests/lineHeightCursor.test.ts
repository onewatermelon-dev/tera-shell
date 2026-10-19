import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  applyReduceMotion,
  clampCursorWidth,
  clampLineHeight,
  DEFAULT_CURSOR_WIDTH,
  DEFAULT_LINE_HEIGHT,
  loadSettings,
  MAX_CURSOR_WIDTH,
  MAX_LINE_HEIGHT,
  MIN_CURSOR_WIDTH,
  MIN_LINE_HEIGHT
} from "@/settings/lib/settings";
import {
  DataName,
  writeData
} from "@/settings/lib/storage";

describe("clampLineHeight", () => {
  it("非法值退回默认行距", () => {
    expect(clampLineHeight(undefined)).toBe(
      DEFAULT_LINE_HEIGHT
    );
    expect(clampLineHeight("abc")).toBe(
      DEFAULT_LINE_HEIGHT
    );
    expect(clampLineHeight(NaN)).toBe(
      DEFAULT_LINE_HEIGHT
    );
  });

  it("越界值夹到边界", () => {
    expect(clampLineHeight(0.5)).toBe(
      MIN_LINE_HEIGHT
    );
    expect(clampLineHeight(3)).toBe(
      MAX_LINE_HEIGHT
    );
  });

  it("对齐到 0.05 档位且不带浮点误差", () => {
    // 1.234 应落到 1.25，且 1.25 要与 UI 下拉的 value 严格相等
    expect(clampLineHeight(1.234)).toBe(1.25);
    expect(clampLineHeight(1.3)).toBe(1.3);
    expect(clampLineHeight("1.55")).toBe(1.55);
  });
});

describe("clampCursorWidth", () => {
  it("非法值退回默认宽度", () => {
    expect(clampCursorWidth(undefined)).toBe(
      DEFAULT_CURSOR_WIDTH
    );
    expect(clampCursorWidth("x")).toBe(
      DEFAULT_CURSOR_WIDTH
    );
  });

  it("越界值夹到边界并取整", () => {
    expect(clampCursorWidth(0)).toBe(
      MIN_CURSOR_WIDTH
    );
    expect(clampCursorWidth(9)).toBe(
      MAX_CURSOR_WIDTH
    );
    expect(clampCursorWidth(2.6)).toBe(3);
  });
});

describe("applyReduceMotion", () => {
  it("打开时挂 data-motion=off，关闭时移除属性", () => {
    // node 环境没有 DOM：applyReduceMotion 只碰 documentElement.dataset，
    // 造一个最小桩就够（dataset 用普通对象模拟，delete 语义一致）
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", {
      documentElement: { dataset }
    });
    applyReduceMotion(true);
    expect(dataset.motion).toBe("off");
    applyReduceMotion(false);
    expect(dataset.motion).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("loadSettings 的新字段", () => {
  beforeEach(() => {
    // writeData 内存先行：清不掉旧缓存就直接覆盖成空，
    // 让 loadSettings 走「没有设置文件」的默认分支再逐个验证
    writeData(DataName.settings, "");
  });
  it("旧数据缺字段时用默认值（1.3 / 1 / outline / 动效默认开）", () => {
    writeData(
      DataName.settings,
      JSON.stringify({ fontSize: 16 })
    );
    const settings = loadSettings();
    expect(settings.lineHeight).toBe(
      DEFAULT_LINE_HEIGHT
    );
    expect(settings.cursorWidth).toBe(
      DEFAULT_CURSOR_WIDTH
    );
    expect(settings.cursorInactiveStyle).toBe(
      "outline"
    );
    expect(settings.reduceMotion).toBe(false);
    // 连接层：私钥留空（交给 ssh 默认）、配置读取默认开
    expect(settings.sshKeyPath).toBe("");
    expect(settings.useSshConfig).toBe(true);
  });

  it("合法值原样保留", () => {
    writeData(
      DataName.settings,
      JSON.stringify({
        lineHeight: 1.8,
        cursorWidth: 2,
        cursorInactiveStyle: "none"
      })
    );
    const settings = loadSettings();
    expect(settings.lineHeight).toBe(1.8);
    expect(settings.cursorWidth).toBe(2);
    expect(settings.cursorInactiveStyle).toBe(
      "none"
    );
  });

  it("非法值退回默认", () => {
    writeData(
      DataName.settings,
      JSON.stringify({
        lineHeight: "abc",
        cursorWidth: -1,
        cursorInactiveStyle: "diagonal"
      })
    );
    const settings = loadSettings();
    expect(settings.lineHeight).toBe(
      DEFAULT_LINE_HEIGHT
    );
    expect(settings.cursorWidth).toBe(
      DEFAULT_CURSOR_WIDTH
    );
    expect(settings.cursorInactiveStyle).toBe(
      "outline"
    );
  });
});
