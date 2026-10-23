/**
 * 终端配色方案：数据来自 mbadolato/iTerm2-Color-Schemes 全集（463 个，
 * 由 scripts/generate-color-schemes.mjs 生成到 colorSchemesData.ts），
 * 这里做类型化、查找与 xterm 主题的换算。
 */
import RAW from "./colorSchemesData";

export type ColorScheme = {
  name: string;
  /** 背景相对亮度判定，设置页按它分「夜间 / 亮色」 */
  dark: boolean;
  background: string;
  foreground: string;
  cursor: string;
  /** 选区底色；空串表示未定义（沿用 xterm 默认选区） */
  selectionBackground: string;
  /** 16 色 ANSI：black red green yellow blue magenta cyan white + bright 同序 */
  ansi: string[];
};

/** 默认方案：与配色功能上线前的终端观感一致（内置字体栈时代的底色）。 */
export const DEFAULT_COLOR_SCHEME = "Tera Shell";

const DEFAULT_SCHEME: ColorScheme = {
  name: DEFAULT_COLOR_SCHEME,
  dark: true,
  background: "#0b0e14",
  foreground: "#c9d1d9",
  cursor: "#2967ce",
  // 内置默认方案没有自己的选区色数据，给一个青蓝色（与光标同族）。
  // 空串会触发 toSelectionCss 的前景色回退
  selectionBackground: "#2a5f8f",
  // xterm 内置 ANSI 默认值：配色功能上线前的终端就用这套
  ansi: [
    "#2e3436",
    "#cc0000",
    "#4e9a06",
    "#c4a000",
    "#3465a4",
    "#75507b",
    "#06989a",
    "#d3d7cf",
    "#555753",
    "#ef2929",
    "#8ae234",
    "#fce94f",
    "#729fcf",
    "#ad7fa8",
    "#34e2e2",
    "#eeeeec"
  ]
};

export const COLOR_SCHEMES: ColorScheme[] = [
  // 内置默认并入列表：用户从别的方案切回来才有入口
  DEFAULT_SCHEME,
  ...RAW.map(
    ([
      name,
      dark,
      background,
      foreground,
      cursor,
      selectionBackground,
      ...ansi
    ]) => ({
      name,
      dark: dark === 1,
      background,
      foreground,
      cursor,
      selectionBackground,
      ansi
    })
  )
].sort((a, b) =>
  a.name.localeCompare(b.name, "en")
);

/** 按名找方案；没找到（数据被裁剪/名字改了）回退默认。 */
export function resolveColorScheme(
  name: string
): ColorScheme {
  return (
    COLOR_SCHEMES.find(
      scheme => scheme.name === name
    ) ?? DEFAULT_SCHEME
  );
}

/**
 * 自绘选区覆盖层用的 CSS `background` 值。
 *
 * ## ⚠️ 第二个参数**必须是 transparent**，不能是背景色
 *
 * 踩过这个坑（症状：用户报「划词的时候看不到文字」——色块明显，
 * 字全没了）：`color-mix(in srgb, A 45%, 背景色)` 混出来是**完全不透明**的
 * 色块，叠在终端文字上就把字盖死了。必须写 `color-mix(in srgb, A 45%,
 * transparent)` —— 选区色本身带 45% 透明度，文字从底下透出来。
 *
 * 之所以曾经想混背景色，是想让「亮色方案不因深灰选区而压没黑字」——
 * 但正确解法就是**降低 alpha**，而不是换混什么。alpha 透明是等效的，
 * 且对任何底色都成立。
 *
 * ## 为什么要自己算，而不是直接用 `selectionBackground`
 *
 * 数据里 463 个方案的选区色**全部有值且全不透明**（`#a5a2a2` 这种）。
 * 直接铺上去必然遮住字符。
 *
 * ## 为什么要留前景色回退
 *
 * 少数方案 `selectionBackground` 是空串 —— 数据源本身没给。回退到
 * **前景色 30% 透明**：同色叠加不改变文字明暗结构，任何主题下被选文字
 * 都清晰（选区色缺失时最保守的选择）。
 *
 * @param scheme 当前配色方案
 */
export function toSelectionCss(
  scheme: ColorScheme
): string {
  const selection =
    scheme.selectionBackground.trim();
  if (!selection)
    return `color-mix(in srgb, ${scheme.foreground} 30%, transparent)`;
  return `color-mix(in srgb, ${selection} 45%, transparent)`;
}

/**
 * 换算成 xterm 的 ITheme 输入（ANSI 16 色逐个展开成具名键）。
 *
 * 划词高亮不在这 —— 终端把原生选区设成透明，视觉由自绘覆盖层
 * （terminalSelection.ts + .terminal-selection-range）负责，颜色见
 * `toSelectionCss`。
 */
/**
 * 配色数据里 `background` 可能是空串（463 个方案里确实有这样的，
 * 和 `selectionBackground` 同一类数据缺口）。空串传给 xterm 等于
 * **背景透明** —— 露出页面白底，而前景色往往是深色主题的浅灰
 * （如 #C9D1D9），于是"浅灰字画在白底上"，看起来就是一片空白。
 * 2026-10-23 实测白屏就是这么来的。
 *
 * 兜底规则：按前景亮度选对比底（浅前景配深底，反之配白底）。
 */
function fallbackBackground(
  foreground: string
): string {
  const match =
    /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(
      foreground.trim()
    );
  if (!match) return "#0d1117";
  let hex = match[1] ?? "";
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map(ch => ch + ch)
      .join("");
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // 相对亮度（sRGB 近似，够判断明暗）
  const luminance =
    (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#0d1117" : "#ffffff";
}

export function toXtermTheme(
  scheme: ColorScheme
): Record<string, string> {
  const theme: Record<string, string> = {
    background:
      scheme.background.trim() ||
      fallbackBackground(scheme.foreground),
    foreground: scheme.foreground,
    cursor: scheme.cursor,
    // 原生选区恒透明：视觉走自绘覆盖层，不能让 xterm 再画一层
    selectionBackground: "#00000000",
    selectionInactiveBackground: "#00000000",
    // 滚动条跟随光标色（配色功能上线前就是这种用法）
    scrollbarSliderBackground: scheme.cursor,
    scrollbarSliderHoverBackground: scheme.cursor,
    scrollbarSliderActiveBackground: scheme.cursor
  };
  const keys = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite"
  ];
  scheme.ansi.forEach((color, index) => {
    theme[keys[index] as string] = color;
  });
  return theme;
}
