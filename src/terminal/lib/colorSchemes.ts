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
  selectionBackground: "",
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
 * 换算成 xterm 的 ITheme 输入（ANSI 16 色逐个展开成具名键）。
 *
 * 划词高亮不在这 —— 终端把原生选区设成透明，视觉由自绘覆盖层
 * （terminalSelection.ts + .terminal-selection-range）负责，颜色是
 * 前景色半透明（CSS 变量 --terminal-fg），任何主题下文字都清晰。
 */
export function toXtermTheme(
  scheme: ColorScheme
): Record<string, string> {
  const theme: Record<string, string> = {
    background: scheme.background,
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
