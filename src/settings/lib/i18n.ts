import {
  useMemo,
  useSyncExternalStore
} from "react";
import type { LanguageMode } from "@/settings/lib/settings";

/**
 * 极简 i18n。
 *
 * 没用 i18next 之类的库：本项目只需要「一份字典 + 一个取值函数」，
 * 引入框架反而多一层依赖和一堆用不上的能力。
 *
 * 语言放在**模块级 store** 里而不是 React Context —— 这样任何组件
 * （包括 App 自己）都能直接 `useT()`，不必为 Provider 再拆一层组件。
 * 订阅方式与项目里选区状态的做法一致（`useSyncExternalStore`）。
 */

export type Locale = "zh-CN" | "en-US";

/**
 * 全部界面文案。
 *
 * 键用「区域.用途」命名，方便定位归属；两种语言必须一一对应，
 * `Messages` 类型会对缺失的键报错。
 */
const zhCN = {
  "common.cancel": "取消",
  "common.save": "保存",
  "common.confirm": "确定",

  "app.menu.file": "文件",
  "app.menu.edit": "编辑",
  "app.menu.view": "查看",
  "app.menu.tools": "工具",
  "app.menu.aria": "应用菜单",
  "app.menu.newSsh": "新建 SSH 会话…",
  "app.menu.openLocal": "打开本地终端",
  "app.menu.closeActive": "关闭当前标签",
  "app.menu.quit": "退出",
  "app.menu.find": "查找…",
  "app.menu.maximize": "最大化窗口",
  "app.menu.restore": "还原窗口",
  "app.action.newSession": "新建会话",
  "app.action.openLocal": "打开本地终端",
  "app.action.closeActive": "关闭当前会话",
  "app.action.find": "查找",
  "app.action.copy": "复制",
  "app.action.paste": "粘贴",
  "app.action.selectAll": "全选",
  "app.action.clear": "清屏",
  "app.action.devtools": "开发者工具",
  "app.action.openSftp": "SFTP 窗口",
  "app.action.settings": "设置",
  "app.action.more": "更多",
  "app.action.minimize": "最小化",
  "app.action.maximize": "最大化",
  "app.action.close": "关闭",
  "app.action.toggleCaseSensitive": "区分大小写",
  "app.action.toggleRegex": "正则表达式",

  "sidebar.title": "会话",
  "sidebar.newSsh": "新建 SSH 会话",
  "sidebar.mine": "我的会话",
  "sidebar.localTerminal": "本机终端",
  "sidebar.noMatch": "没有匹配的会话",
  "sidebar.ready": "就绪",
  "sidebar.connections": "{count} 个连接",

  "session.editTitle": "编辑连接",
  "session.newTitle": "新建连接",
  "session.eyebrow": "SSH 会话",
  "session.name": "会话名称",
  "session.namePlaceholder":
    "选填，留空使用主机地址",
  "session.host": "主机地址",
  "session.port": "端口",
  "session.username": "用户名",
  "session.password": "修改密码",
  "session.passwordPlaceholder": "留空保持原密码",
  "session.authHint":
    "身份验证由系统 SSH 处理，支持已有密钥和 ssh-agent。",
  "session.save": "保存会话",
  "session.hostRequired": "请填写主机地址",
  "sidebar.searchPlaceholder": "搜索会话",
  "sidebar.empty": "还没有会话",
  "sidebar.connect": "连接",
  "sidebar.edit": "编辑",
  "sidebar.duplicate": "复制会话",
  "sidebar.remove": "删除",

  "terminal.emptyTitle": "选择一个会话开始连接",
  "terminal.emptyDesc":
    "从左侧打开本地终端，或新建一个 SSH 会话。",
  "terminal.newTab": "新建会话",
  "terminal.closeTab": "关闭标签",
  "terminal.closeRight": "关闭右侧会话",
  "terminal.closeOthers": "关闭其他会话",
  "terminal.closeAll": "关闭所有会话",
  "terminal.splitRight": "向右拆分",
  "terminal.moreTabs": "更多标签",
  "terminal.overflowTabs":
    "{count} 个标签超出显示",
  "terminal.find.placeholder": "查找",
  "terminal.find.prev": "上一个 (Shift+Enter)",
  "terminal.find.next": "下一个 (Enter)",
  "terminal.find.caseSensitive": "区分大小写",
  "terminal.find.regex": "正则表达式",
  "terminal.find.close": "关闭 (Esc)",
  "terminal.find.noMatch": "无匹配",
  "terminal.passwordHint":
    "密码输入不会显示字符或 *，输入完成后直接按 Enter。",
  "terminal.exited": "[会话已结束]",
  "terminal.confirmClose": "确定关闭这个会话吗？",
  "terminal.needSession": "请先打开一个会话",

  "macro.title": "快捷宏",
  "macro.add": "新增快捷宏",
  "macro.run": "执行：{command}",
  "macro.edit": "编辑快捷宏",
  "macro.empty":
    "还没有快捷宏，点右侧 + 添加常用命令",
  "macro.editAction": "编辑",
  "macro.deleteAction": "删除",
  "macro.name": "名称",
  "macro.command": "命令",
  "macro.namePlaceholder": "名称（可留空）",
  "macro.commandPlaceholder":
    "命令，例如 git pull\n多行会依次执行（相当于每行敲一次回车）",

  "settings.nav.group": "基础设置",
  "settings.nav.general": "常规",
  "settings.nav.terminal": "终端",
  "settings.back": "返回工作区",
  "settings.subtitle":
    "修改后立即写入本地，仅对本机生效",
  "settings.locale.title": "界面语言",
  "settings.locale.desc":
    "选择应用界面的显示语言；跟随系统时读取操作系统的语言设置。",
  "settings.theme.title": "系统主题",
  "settings.theme.desc":
    "跟随系统时会随操作系统的深浅色设置自动切换。",
  "settings.font.title": "终端字体",
  "settings.font.desc":
    "留空时使用内置字体栈；填写后作为首选，缺失时按内置列表回退。",
  "settings.font.placeholder": "当前字体：{name}",
  "settings.fontSize.title": "终端字号",
  "settings.fontSize.desc":
    "单位像素，可填 {min} 到 {max}，超出范围会自动收敛。",
  "settings.dataDir.title": "数据存储路径",
  "settings.dataDir.desc":
    "会话、设置与快捷宏的导出目录（默认为用户主目录）。保存后会把现有数据复制到新位置；路径后缀 .tera-shell 不可更改。",
  "settings.dataDir.pick": "选择文件夹",
  "settings.dataDir.placeholder":
    "留空使用默认位置",
  "settings.dataDir.saved": "已写入 {path}",

  "option.system": "跟随系统",
  "option.light": "浅色",
  "option.dark": "深色",
  "option.zhCN": "简体中文",
  "option.enUS": "English"
} as const;

export type MessageKey = keyof typeof zhCN;

const enUS: Record<MessageKey, string> = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.confirm": "Confirm",

  "app.menu.file": "File",
  "app.menu.edit": "Edit",
  "app.menu.view": "View",
  "app.menu.tools": "Tools",
  "app.menu.aria": "Application menu",
  "app.menu.newSsh": "New SSH session…",
  "app.menu.openLocal": "Open local terminal",
  "app.menu.closeActive": "Close current tab",
  "app.menu.quit": "Quit",
  "app.menu.find": "Find…",
  "app.menu.maximize": "Maximize window",
  "app.menu.restore": "Restore window",
  "app.action.newSession": "New session",
  "app.action.openLocal": "Open local terminal",
  "app.action.closeActive":
    "Close current session",
  "app.action.find": "Find",
  "app.action.copy": "Copy",
  "app.action.paste": "Paste",
  "app.action.selectAll": "Select all",
  "app.action.clear": "Clear",
  "app.action.devtools": "Developer tools",
  "app.action.openSftp": "SFTP window",
  "app.action.settings": "Settings",
  "app.action.more": "More",
  "app.action.minimize": "Minimize",
  "app.action.maximize": "Maximize",
  "app.action.close": "Close",
  "app.action.toggleCaseSensitive": "Match case",
  "app.action.toggleRegex":
    "Use regular expression",

  "sidebar.title": "Sessions",
  "sidebar.newSsh": "New SSH session",
  "sidebar.mine": "My sessions",
  "sidebar.localTerminal": "Local terminal",
  "sidebar.noMatch": "No matching sessions",
  "sidebar.ready": "Ready",
  "sidebar.connections": "{count} connections",

  "session.editTitle": "Edit connection",
  "session.newTitle": "New connection",
  "session.eyebrow": "SSH session",
  "session.name": "Session name",
  "session.namePlaceholder":
    "Optional — falls back to the host",
  "session.host": "Host",
  "session.port": "Port",
  "session.username": "Username",
  "session.password": "Change password",
  "session.passwordPlaceholder":
    "Leave empty to keep the current password",
  "session.authHint":
    "Authentication is handled by the system SSH client, so existing keys and ssh-agent both work.",
  "session.save": "Save session",
  "session.hostRequired": "Host is required",
  "sidebar.searchPlaceholder": "Search sessions",
  "sidebar.empty": "No sessions yet",
  "sidebar.connect": "Connect",
  "sidebar.edit": "Edit",
  "sidebar.duplicate": "Duplicate session",
  "sidebar.remove": "Delete",

  "terminal.emptyTitle":
    "Pick a session to connect",
  "terminal.emptyDesc":
    "Open a local terminal on the left, or create an SSH session.",
  "terminal.newTab": "New session",
  "terminal.closeTab": "Close tab",
  "terminal.closeRight":
    "Close tabs to the right",
  "terminal.closeOthers": "Close other tabs",
  "terminal.closeAll": "Close all tabs",
  "terminal.splitRight": "Split right",
  "terminal.moreTabs": "More tabs",
  "terminal.overflowTabs":
    "{count} tabs are out of view",
  "terminal.find.placeholder": "Find",
  "terminal.find.prev": "Previous (Shift+Enter)",
  "terminal.find.next": "Next (Enter)",
  "terminal.find.caseSensitive": "Match case",
  "terminal.find.regex": "Regular expression",
  "terminal.find.close": "Close (Esc)",
  "terminal.find.noMatch": "No matches",
  "terminal.passwordHint":
    "Password input stays hidden — no characters or asterisks. Press Enter when done.",
  "terminal.exited": "[session ended]",
  "terminal.confirmClose": "Close this session?",
  "terminal.needSession": "Open a session first",

  "macro.title": "Quick macros",
  "macro.add": "Add macro",
  "macro.run": "Run: {command}",
  "macro.edit": "Edit macro",
  "macro.empty":
    "No macros yet — click + on the right to add a command",
  "macro.editAction": "Edit",
  "macro.deleteAction": "Delete",
  "macro.name": "Name",
  "macro.command": "Command",
  "macro.namePlaceholder": "Name (optional)",
  "macro.commandPlaceholder":
    "Command, e.g. git pull\nMultiple lines run in order, as if pressing Enter after each",

  "settings.nav.group": "Basics",
  "settings.nav.general": "General",
  "settings.nav.terminal": "Terminal",
  "settings.back": "Back to workspace",
  "settings.subtitle":
    "Saved locally and applied to this machine only",
  "settings.locale.title": "Interface language",
  "settings.locale.desc":
    "Language used by the app UI. Follows the system setting when set to that.",
  "settings.theme.title": "Theme",
  "settings.theme.desc":
    "Follow system switches automatically with the OS appearance.",
  "settings.font.title": "Terminal font",
  "settings.font.desc":
    "Leave empty to use the built-in stack. A custom family is tried first and falls back to the built-in list.",
  "settings.font.placeholder":
    "Current font: {name}",
  "settings.fontSize.title": "Terminal font size",
  "settings.fontSize.desc":
    "In pixels, from {min} to {max}; out-of-range values are clamped.",
  "settings.dataDir.title": "Data location",
  "settings.dataDir.desc":
    "Where sessions, settings and macros are exported (defaults to your home directory). Saving copies the current data to the new location; the .tera-shell suffix is fixed.",
  "settings.dataDir.pick": "Choose folder",
  "settings.dataDir.placeholder":
    "Empty uses the default location",
  "settings.dataDir.saved": "Written to {path}",

  "option.system": "Follow system",
  "option.light": "Light",
  "option.dark": "Dark",
  "option.zhCN": "简体中文",
  "option.enUS": "English"
};

const DICTIONARIES: Record<
  Locale,
  Record<MessageKey, string>
> = {
  "zh-CN": zhCN,
  "en-US": enUS
};

/** 翻译函数。`{name}` 形式的占位符由第二参数替换。 */
export type Translator = (
  key: MessageKey,
  vars?: Record<string, string | number>
) => string;

/** 中文是唯一的全量字典，缺键时回退到它。 */
function normalizeLocale(
  locale: LanguageMode
): Locale {
  if (locale === "en-US") return "en-US";
  if (locale === "zh-CN") return "zh-CN";
  // 跟随系统：非中文环境一律给英文
  return navigator.language
    ?.toLowerCase()
    .startsWith("zh")
    ? "zh-CN"
    : "en-US";
}

// ---- 模块级 store：任何组件都能直接读，不必套 Provider ----

let current: Locale = "zh-CN";
const listeners = new Set<() => void>();

/** 由 useSettings 在语言变化时调用。 */
export function setLocale(
  locale: LanguageMode
): void {
  const next = normalizeLocale(locale);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Locale {
  return current;
}

function createTranslator(
  locale: Locale
): Translator {
  const dictionary = DICTIONARIES[locale];
  return (key, vars) => {
    // 英文缺失时回退中文，宁可出现少量中文也不要露出原始键名
    const template =
      dictionary[key] ?? zhCN[key] ?? key;
    if (!vars) return template;
    return template.replace(
      /\{(\w+)\}/g,
      (match, name: string) =>
        name in vars ? String(vars[name]) : match
    );
  };
}

/** 取当前语言的翻译函数；语言切换时使用它的组件会自动重渲染。 */
export function useT(): Translator {
  const locale = useSyncExternalStore(
    subscribe,
    getSnapshot
  );
  return useMemo(
    () => createTranslator(locale),
    [locale]
  );
}
