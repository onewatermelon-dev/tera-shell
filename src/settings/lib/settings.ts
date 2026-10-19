import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import {
  sanitizeOverrides,
  type ShortcutOverrides
} from "@/shared/lib/appShortcuts";

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

/**
 * SSH 主机密钥策略（对应 ssh 的 StrictHostKeyChecking）：
 * - accept-new：新主机自动钉扎（TOFU），已知主机指纹**变更时拒绝连接**
 * - ask：新主机在终端里交互询问（ssh 原生 yes/no 提示）
 * - strict：只连 known_hosts 里指纹一致的主机，新主机直接拒绝
 */
export type HostKeyPolicy =
  "accept-new" | "ask" | "strict";

/** 底部状态栏的形态：macros=快捷宏，info=系统信息栏。 */
export type StatusMode = "macros" | "info";

/** 终端光标形状。 */
export type CursorStyle =
  "block" | "underline" | "bar";

/**
 * 焦点不在终端上时的光标形态（xterm 的 `cursorInactiveStyle`）。
 *
 * outline 是 xterm 默认：方块退成描边，「还在但不归你管」一眼可辨；
 * none 直接隐藏。与 CursorStyle 同的三个值表示「失焦也保持原形状」。
 */
export type CursorInactiveStyle =
  | "outline"
  | "block"
  | "underline"
  | "bar"
  | "none";

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
  /** 终端光标形状（设置-终端里选择）。 */
  cursorStyle: CursorStyle;
  /** 终端光标是否闪烁（设置-终端里开关）。 */
  cursorBlink: boolean;
  /**
   * 行距：字符行盒高度的倍数（xterm 的 `lineHeight`）。
   *
   * 1 = 一行挨一行，2 = 一倍空行。行距一改行高就变，
   * 终端行列数必须重算 —— 生效链路见 useTerminalAppearance。
   */
  lineHeight: number;
  /**
   * 光标宽度（xterm 的 `cursorWidth`），单位 px，仅对竖线/下划线形状生效。
   *
   * xterm 默认 1px，高分屏上细得几乎看不见 —— 这是加它的唯一理由。
   */
  cursorWidth: number;
  /** 失焦时的光标形态（设置-终端里选择），见 CursorInactiveStyle。 */
  cursorInactiveStyle: CursorInactiveStyle;
  /**
   * 减少动效：关掉标签名跑马灯、加载动画等持续动效（无障碍项）。
   *
   * 系统级的 `prefers-reduced-motion` 已有两处 CSS 媒体查询在跟，
   * 但没给应用内开关 —— 用户没法在不改系统设置的前提下关动画。
   * 打开时根节点挂 `data-motion="off"`，样式层两套选择器并行生效。
   */
  reduceMotion: boolean;
  /**
   * 硬件加速渲染（WebGL）。
   *
   * 关掉后终端退回 DOM 渲染器：大输出时滚动/输入会明显变涩，
   * 但在显卡驱动异常、或发现 WebGL 下有渲染怪象（缺色、字形缺失）时
   * 是一条现成的退路 —— 也是排查此类问题时该先试的一步。
   */
  webglRender: boolean;
  /**
   * 终端回滚行数：内存里保留多少行历史输出（设置-终端里选择）。
   *
   * 传给 xterm 的 `scrollback`，见 MIN_SCROLLBACK/MAX_SCROLLBACK。
   */
  scrollback: number;
  /**
   * 数据存储目录。空字符串表示用默认位置（用户主目录）。
   *
   * 会话、设置、宏等数据都以文件形式存这里（见 storage.ts 的存储层），
   * 换目录时整批迁移。
   */
  dataDir: string;
  /**
   * 用户自定义的快捷键：`动作 id → 键位串`，只存与默认值不同的。
   *
   * ⚠️ 放在 settings 里而不是单独一个数据文件：单独开文件要同时改
   * `storage.ts` 的 `DataName` 与后端 `data/mod.rs` 的 `ALLOWED`
   * （两个定长数组，长度要同步），为这一个字段不值得。
   * 校验交给 `appShortcuts` 的 `sanitizeOverrides`（见 setShortcutOverrides）。
   */
  shortcutOverrides: ShortcutOverrides;
  /**
   * 是否让出站请求走代理（AI 模型请求、检查更新）。
   *
   * 开关与地址分开：地址留着、临时关掉代理是常见操作（比如代理软件没开
   * 又不想重填地址），合成一个字段就得连地址一起清。
   */
  proxyEnabled: boolean;
  /**
   * 代理地址，支持 `http://` / `socks5://` / `socks5h://`。
   *
   * ⚠️ 这里可能含用户名密码。**它会原样写进 settings.json**，而该文件
   * 不加密（会话密码才走 DPAPI，见 session.ts）。因此该文件不要提交到
   * 公开仓库、也不要打进安装包。
   */
  proxyUrl: string;
  /**
   * 默认 SSH 私钥路径（传给 ssh 的 `-i`）。空字符串 = 不指定，
   * 交给 ssh 自己走默认密钥与 agent。
   *
   * ⚠️ 是「默认」而非每会话：目前会话模型没有 keyPath 字段，全局统一。
   */
  sshKeyPath: string;
  /**
   * 是否读取 ~/.ssh/config（ProxyJump、Host 别名等都在里面）。
   *
   * 关掉时后端传 `-F /dev/null`（Windows 为 `-F NUL`）——
   * ssh 默认行为就是读它，这个开关只能「关」不能指定别的文件。
   */
  useSshConfig: boolean;
  /**
   * 主机密钥策略（设置-常规里选），见 HostKeyPolicy。
   *
   * 指纹变更被拒时 ssh 也以 255 退出，与网络断开无法从退出码区分 ——
   * 前端靠输出里的标记文本识别，不白白重连（见 reconnect.ts）。
   */
  hostKeyPolicy: HostKeyPolicy;
  /** 系统通知总开关；关掉时下面三项都不生效 */
  notifyEnabled: boolean;
  /** 长命令跑完时通知 */
  notifyCommand: boolean;
  /** AI 回答完成时通知 */
  notifyAi: boolean;
  /** 传输结束时通知 */
  notifyTransfer: boolean;
};

/** 终端字体的内置默认值：与创建 Terminal 时的取值保持一致。 */
export const TERMINAL_FONT_FALLBACK =
  '"Cascadia Code", "JetBrains Mono", Consolas, monospace';

/**
 * 行距可调范围与默认值。
 *
 * 下限 1（自然排布，再小就叠字），上限 2（恰好一行空白）；
 * 默认 1.3 —— 与此前硬编码在 terminalCreate 的值一致，升级不改变观感。
 */
export const MIN_LINE_HEIGHT = 1;
export const MAX_LINE_HEIGHT = 2;
export const DEFAULT_LINE_HEIGHT = 1.3;

/** 行距步进（0.05 一档）：设置页下拉按它生成选项。 */
export const LINE_HEIGHT_STEP = 0.05;

/** 光标宽度可调范围与默认值。1 是 xterm 默认，4 已经像一堵墙。 */
export const MIN_CURSOR_WIDTH = 1;
export const MAX_CURSOR_WIDTH = 4;
export const DEFAULT_CURSOR_WIDTH = 1;

/**
 * 把任意输入夹到合法行距；非法值一律退回默认，并对齐到 0.05 档位。
 *
 * 用乘 20 取整而不是 toFixed：后者返回字符串，parseFloat 再转一次
 * 纯属绕路，且 1.25 这类值在二进制下本就有误差，取整足以消掉。
 */
export function clampLineHeight(
  value: unknown
): number {
  const height = Number(value);
  if (!Number.isFinite(height))
    return DEFAULT_LINE_HEIGHT;
  const clamped = Math.min(
    MAX_LINE_HEIGHT,
    Math.max(MIN_LINE_HEIGHT, height)
  );
  return (
    Math.round(clamped / LINE_HEIGHT_STEP) *
    LINE_HEIGHT_STEP
  );
}

/** 把任意输入夹到合法主机密钥策略；非法值一律退回 accept-new。 */
export function clampHostKeyPolicy(
  value: string
): HostKeyPolicy {
  return value === "ask" || value === "strict"
    ? value
    : "accept-new";
}

/** 把任意输入夹到合法光标宽度（整数 px）；非法值一律退回默认。 */
export function clampCursorWidth(
  value: unknown
): number {
  const width = Number(value);
  if (!Number.isFinite(width))
    return DEFAULT_CURSOR_WIDTH;
  return Math.min(
    MAX_CURSOR_WIDTH,
    Math.max(MIN_CURSOR_WIDTH, Math.round(width))
  );
}

/** 字号可调范围。太小看不清，太大一屏放不下几行。 */
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_FONT_SIZE = 14;

/**
 * 回滚行数（xterm 的 `scrollback`）：终端在内存里保留多少行历史输出，
 * 决定滚轮向上能翻多远。
 *
 * 每行都要占内存（还带颜色等属性），且**每个终端实例各留一份** ——
 * 开满 4 个 pane 就是四倍。上限放到 10 万行，够翻完一整个编译日志，
 * 又不至于把内存吃穿；下限 500 行保证最基本的回看能力。
 */
export const MIN_SCROLLBACK = 500;
export const MAX_SCROLLBACK = 100000;
export const DEFAULT_SCROLLBACK = 5000;

/**
 * 设置页下拉里的档位。
 *
 * 不给任意输入：改回滚行数会立刻裁剪或保留缓冲区内容，
 * 逐字符输入会一路触发，点选一次到位更稳（与字号同一考虑）。
 */
export const SCROLLBACK_PRESETS = [
  1000, 2000, 5000, 10000, 20000, 50000, 100000
];

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
  cursorStyle: "block",
  cursorBlink: true,
  lineHeight: DEFAULT_LINE_HEIGHT,
  cursorWidth: DEFAULT_CURSOR_WIDTH,
  cursorInactiveStyle: "outline",
  // 默认关：动画对多数人无害，需要的人再开
  reduceMotion: false,
  webglRender: true,
  scrollback: DEFAULT_SCROLLBACK,
  dataDir: "",
  proxyEnabled: false,
  proxyUrl: "",
  sshKeyPath: "",
  // 默认读：与 ssh 自身默认行为一致，旧数据也无此字段
  useSshConfig: true,
  // 默认 accept-new：与此前硬编码行为一致，升级不改变连接体验
  hostKeyPolicy: "accept-new",
  // 通知默认全关：系统通知会弹到桌面上去，属于「用户明确要求被打扰」
  // 的行为，不该由安装默认开启
  notifyEnabled: false,
  notifyCommand: true,
  notifyAi: true,
  notifyTransfer: true,
  shortcutOverrides: {}
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

/** 把任意输入夹到合法回滚行数；非法值（含 0 与负数）一律退回默认。 */
export function clampScrollback(
  value: unknown
): number {
  const lines = Number(value);
  if (!Number.isFinite(lines) || lines <= 0)
    return DEFAULT_SCROLLBACK;
  return Math.min(
    MAX_SCROLLBACK,
    Math.max(MIN_SCROLLBACK, Math.round(lines))
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
      // 光标形状非法值一律退回方块
      cursorStyle:
        parsed.cursorStyle === "underline" ||
        parsed.cursorStyle === "bar"
          ? parsed.cursorStyle
          : "block",
      cursorBlink: parsed.cursorBlink !== false,
      // 行距 / 光标宽度：旧数据没这两个字段时 clamp 会退回默认值
      lineHeight: clampLineHeight(
        parsed.lineHeight
      ),
      cursorWidth: clampCursorWidth(
        parsed.cursorWidth
      ),
      // 失焦光标：非法值退回 outline（xterm 默认）
      cursorInactiveStyle:
        parsed.cursorInactiveStyle === "block" ||
        parsed.cursorInactiveStyle ===
          "underline" ||
        parsed.cursorInactiveStyle === "bar" ||
        parsed.cursorInactiveStyle === "none"
          ? parsed.cursorInactiveStyle
          : "outline",
      // 减少动效：默认关，只有显式存过 true 才开
      reduceMotion: parsed.reduceMotion === true,
      // 默认开：只有显式存过 false 才关
      webglRender: parsed.webglRender !== false,
      // 回滚行数：旧数据没这个字段（undefined）时 clampScrollback
      // 会退回默认值，无需额外判断
      scrollback: clampScrollback(
        parsed.scrollback
      ),
      dataDir:
        typeof parsed.dataDir === "string"
          ? parsed.dataDir
          : "",
      // 代理：默认关（旧设置没这两项时不要突然开始走代理）。
      // 地址只 trim 不校验 —— 校验放在设置页做，这里保持宽松，
      // 免得手改文件填了个带空格的值就被静默改写
      proxyEnabled: parsed.proxyEnabled === true,
      proxyUrl:
        typeof parsed.proxyUrl === "string"
          ? parsed.proxyUrl.trim()
          : "",
      // 私钥路径只 trim 不校验存在性：文件可能在另一台机器/尚未生成，
      // 校验交给 ssh 自己报错（它会明确说 No such file）
      sshKeyPath:
        typeof parsed.sshKeyPath === "string"
          ? parsed.sshKeyPath.trim()
          : "",
      // 默认读（旧数据缺字段 = true）
      useSshConfig: parsed.useSshConfig !== false,
      // 密钥策略：非法值（手改设置文件）退回 accept-new
      hostKeyPolicy: clampHostKeyPolicy(
        String(parsed.hostKeyPolicy ?? "")
      ),
      // 通知：总开关默认关（弹到桌面上的行为不该由安装默认开启），
      // 三个分类开关默认开 —— 用户打开总开关时多半是三样都想要
      notifyEnabled:
        parsed.notifyEnabled === true,
      notifyCommand:
        parsed.notifyCommand !== false,
      notifyAi: parsed.notifyAi !== false,
      notifyTransfer:
        parsed.notifyTransfer !== false,
      // 快捷键覆盖：手改过设置文件的话这里可能有未知 id / 撞车键位，
      // sanitizeOverrides 会剔掉（见 appShortcuts）
      shortcutOverrides: sanitizeOverrides(
        parsed.shortcutOverrides
      )
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
 * 把「减少动效」应用到文档根元素。
 *
 * 与 applyTheme 同套路：根节点挂 `data-motion="off"`，CSS 里为每个动画
 * 并行写两套选择器（系统媒体查询 + 属性选择器），避免 JS 逐条改样式。
 * 关闭时移除属性，动画行为完全交回给系统偏好。
 */
export function applyReduceMotion(
  reduceMotion: boolean
): void {
  const root = document.documentElement;
  if (reduceMotion) {
    root.dataset.motion = "off";
  } else {
    delete root.dataset.motion;
  }
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
