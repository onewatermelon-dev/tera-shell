import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/**
 * 应用设置：界面语言、终端字体、字号与界面主题。
 *
 * 存文件（见 storage.ts），键为 `settings` —— 这些都是「跟着这台机器的人走」
 * 的显示偏好，没必要跟着项目走。
 */

/** 主题模式。system 表示交给操作系统，不干预。 */
export type ThemeMode =
  "system" | "light" | "dark";

/** 界面语言。system 表示跟随操作系统。 */
export type LanguageMode =
  "system" | "zh-CN" | "en-US";

/** 底部状态栏的形态：macros=快捷宏，info=系统信息栏。 */
export type StatusMode = "macros" | "info";

export type AppSettings = {
  /** 终端字体族。留空表示用内置默认（见 TERMINAL_FONT_FALLBACK）。 */
  fontFamily: string;
  /** 终端字号，单位 px。 */
  fontSize: number;
  /** 终端配色方案名（见 terminal/lib/colorSchemes 的 COLOR_SCHEMES）。 */
  colorScheme: string;
  theme: ThemeMode;
  locale: LanguageMode;
  /** 会话栏是否展开；收起后靠左缘细条上的按钮恢复。 */
  sidebarOpen: boolean;
  /** 底部状态栏内容：见 StatusMode。 */
  statusMode: StatusMode;
  /** SSH 会话欢迎卡片浮层是否展示（设置-终端里开关）。 */
  welcomeCard: boolean;
  /** 终端命令补全（ghost text 内联建议）是否开启（设置-终端里开关）。 */
  commandCompletion: boolean;
  /**
   * 数据存储目录。空字符串表示用默认位置（用户主目录）。
   *
   * 会话、设置、宏等数据都以文件形式存这里（见 storage.ts 的存储层），
   * 换目录时整批迁移。
   */
  dataDir: string;
};

/** 终端字体的内置默认值：与创建 Terminal 时的取值保持一致。 */
export const TERMINAL_FONT_FALLBACK =
  '"Cascadia Code", "JetBrains Mono", Consolas, monospace';

/** 字号可调范围。太小看不清，太大一屏放不下几行。 */
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_FONT_SIZE = 14;

export const defaultSettings: AppSettings = {
  fontFamily: "",
  fontSize: DEFAULT_FONT_SIZE,
  colorScheme: "Tera Shell",
  theme: "system",
  locale: "system",
  sidebarOpen: true,
  statusMode: "macros",
  welcomeCard: true,
  commandCompletion: true,
  dataDir: ""
};

/** 把任意输入夹到合法字号；非法值一律退回默认。 */
export function clampFontSize(
  value: unknown
): number {
  const size = Number(value);
  if (!Number.isFinite(size))
    return DEFAULT_FONT_SIZE;
  return Math.min(
    MAX_FONT_SIZE,
    Math.max(MIN_FONT_SIZE, Math.round(size))
  );
}

/** 读取设置；任何异常都退回默认值。 */
export function loadSettings(): AppSettings {
  try {
    const raw = readData(DataName.settings);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(
      raw
    ) as Partial<AppSettings>;
    const theme: ThemeMode =
      parsed.theme === "light" ||
      parsed.theme === "dark"
        ? parsed.theme
        : "system";
    const locale: LanguageMode =
      parsed.locale === "zh-CN" ||
      parsed.locale === "en-US"
        ? parsed.locale
        : "system";
    return {
      fontFamily:
        typeof parsed.fontFamily === "string"
          ? parsed.fontFamily
          : "",
      fontSize: clampFontSize(parsed.fontSize),
      // 方案名找不到时会回退默认（resolveColorScheme），这里不做校验
      colorScheme:
        typeof parsed.colorScheme === "string"
          ? parsed.colorScheme
          : "Tera Shell",
      theme,
      locale,
      // 只有显式存过 false 才算收起，其余（含旧数据缺字段）一律展开
      sidebarOpen: parsed.sidebarOpen !== false,
      statusMode:
        parsed.statusMode === "info"
          ? "info"
          : "macros",
      // 默认开：只有显式存过 false 才关（旧数据缺字段视为开）
      welcomeCard: parsed.welcomeCard !== false,
      commandCompletion:
        parsed.commandCompletion !== false,
      dataDir:
        typeof parsed.dataDir === "string"
          ? parsed.dataDir
          : ""
    };
  } catch {
    return defaultSettings;
  }
}

/** 保存设置；写盘失败只记日志，不影响本次会话的使用。 */
export function saveSettings(
  settings: AppSettings
): void {
  writeData(
    DataName.settings,
    JSON.stringify(settings)
  );
}

/**
 * 终端实际使用的字体族。
 *
 * 用户在设置里写了就额外拼在前面 —— 他写的字体若没装，浏览器会顺着
 * 回退到内置列表，不会变成难看的默认衬线体。
 */
export function resolveFontFamily(
  fontFamily: string
): string {
  const custom = fontFamily.trim();
  return custom
    ? `${custom}, ${TERMINAL_FONT_FALLBACK}`
    : TERMINAL_FONT_FALLBACK;
}

/**
 * 取字体栈里第一个名字（剥掉引号），用于展示「当前字体」。
 *
 * 输入框在用户没填内容时显示它 —— 空白会让人不知道现在用的是什么。
 */
export function firstFontOf(
  stack: string
): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/**
 * 把主题应用到文档根元素。
 *
 * HeroUI 的变量表同时认 `.dark` 与 `[data-theme="dark"]`，选属性写法，
 * 避免和组件库自己的 `.dark` 类语义打架。system 时**移除**属性，
 * 交回给 `prefers-color-scheme`。
 */
export function applyTheme(
  theme: ThemeMode
): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
    root.style.removeProperty("color-scheme");
    return;
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * 解析出真正生效的语言标签（如 `zh-CN`），system 时读浏览器/系统设置。
 *
 * 界面文案目前只有中文，这里先把结果落到 `<html lang>` 上 ——
 * 它本身就有实际作用（断词、字体回退、屏幕阅读器发音），
 * 也为将来接入多语言留好了取值入口。
 */
export function resolveLocale(
  locale: LanguageMode
): string {
  if (locale !== "system") return locale;
  return navigator.language || "zh-CN";
}

/** 把语言写到文档根元素上。 */
export function applyLocale(
  locale: LanguageMode
): void {
  document.documentElement.lang =
    resolveLocale(locale);
}
