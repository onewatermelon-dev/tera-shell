import { useSyncExternalStore } from "react";

/**
 * 应用级快捷键表：菜单项 id → 键位。
 *
 * 为什么要有这张表：**三个地方**都要显示/处理同一个键位 ——
 * `AppRail` 的应用菜单、`terminalContextMenu` 的终端右键菜单、
 * `AppHeader` 的按键处理。各写一份必然漂移（改了标签忘了改处理，
 * 或反之），所以键位只在这里定义一次，三处都从这里取。
 *
 * ⚠️ **选键原则：能用 `Ctrl+Shift+X` 就别用裸 `Ctrl+X`**。
 * 裸 `Ctrl+<字母>` 在远端 shell（readline / emacs 键位）里几乎全被占用：
 * Ctrl+A/E/K/U/W/L/R/P/N/B/F/D/C/Z… 一按就是 shell 的行编辑动作。
 * 所以应用级动作一律退到 `Ctrl+Shift` 这个基本空着的命名空间，
 * 只保留三个例外（见 PLAIN_CTRL_OK）。`Ctrl+Shift+X` 是终端里少见的组合，
 * readline 基本不消费它。
 *
 * ============================ 用户自定义 ============================
 *
 * 下面的 `APP_SHORTCUTS` 是**默认表**（出厂键位）。用户改过的部分存
 * `overrides`，两者合并成「生效表」—— 见本文件下半部分的 store。
 * 三处消费方读的都是 `effectiveShortcuts()` / `shortcutOf()`，
 * **不要再直接读 `APP_SHORTCUTS`**，否则用户改的键位不生效。
 * 默认表本身仍要保持「无重复、无裸 Ctrl 占用 readline」的纪律，
 * 有单测盯着（`tests/appShortcuts.test.ts`）。
 */

/**
 * 这几个动作在 `useTerminals` 里实现（`attachCustomKeyEventHandler`
 * 与挂载期的 window 捕获监听），`AppHeader` 不重复绑定 —— 否则同一次
 * 按键会触发两遍（`openSearch` 被调两次）。
 *
 * ⚠️ **「在别处实现」≠「不可自定义」**：那边读的是同一张生效表，
 * 用户改键位照样生效。标记只用于「跳过重复绑定」。
 * ⚠️ `Ctrl+Shift+I` 是 devtools 的**额外别名**（F12 之外的历史遗留），
 * 不在表里、也不可自定义 —— 见 DEVTOOLS_ALT_CHORD。
 */
const HANDLED_ELSEWHERE = new Set([
  "find",
  "devtools"
]);

/**
 * 开发者的额外别名（不可自定义，只用于命中即开 DevTools）。
 *
 * 为什么留：`Ctrl+Shift+I` 是浏览器与多数工具的惯用键，用户按惯了。
 * 为什么不进表：它是 F12 的补充而非替代 —— 进表就意味着「用户可以把它
 * 改掉」，那会破坏「F12 恒定能开 DevTools」这个预期。
 */
export const DEVTOOLS_ALT_CHORD = "Ctrl+Shift+I";

/**
 * 菜单项 id → 键位显示串。
 *
 * 显示串用平台习惯的写法（`Ctrl+Shift+N`）；实际匹配走 `matchChord`，
 * 它同时认 ctrl 与 meta（Mac 上 Ctrl 与 Cmd 等价）。
 */
export const APP_SHORTCUTS: Record<
  string,
  string
> = {
  // ---- 文件 ----
  // N = New。注意不用 Ctrl+N：那是 readline 的「下一条历史」。
  newSession: "Ctrl+Shift+N",
  // O = Open。Ctrl+O 在 readline 里是「用编辑器打开当前行」。
  openLocal: "Ctrl+Shift+O",
  // E = Export。Ctrl+E 是 readline 的「移到行尾」。
  exportSessions: "Ctrl+Shift+E",
  // R = Restore from file。⚠️ 不用 Ctrl+Shift+I：那被开发者工具占了
  //（`useTerminals` 里 `F12` 与 `Ctrl+Shift+I` 都开 DevTools）。
  importSessions: "Ctrl+Shift+R",
  // W = 关闭，抄浏览器的 Ctrl+W 观感；裸 Ctrl+W 是 readline 删前一个词。
  closeActive: "Ctrl+Shift+W",
  // Q = Quit。裸 Ctrl+Q 在很多 shell 里是退出会话，不能抢。
  quit: "Ctrl+Shift+Q",

  // ---- 编辑 ----
  // C / V 沿用 xterm 自己处理的原生编辑键：终端里有选区时浏览器
  // 自动走复制，没有选区时 Ctrl+C 必须是 SIGINT ——**不能**改成
  // 全局 Ctrl+C 把中断功能抢走。
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  // A = All。Ctrl+A 是 readline 的「移到行首」。
  selectAll: "Ctrl+Shift+A",
  // K = clear。Ctrl+K 是 readline 的「杀掉到行尾」。
  clear: "Ctrl+Shift+K",

  // ---- 查看 ----
  // 已由 useTerminals 处理，菜单照常显示键位。
  find: "Ctrl+F",
  // ⚠️ 这里曾有 `toggleCaseSensitive`（Ctrl+Shift+C）与 `toggleRegex`
  // （Ctrl+Shift+G）两项，用户要求取消。它们的实现在查找面板里
  // （面板上有「区分大小写 / 正则表达式」两个按钮，见 TerminalWorkspace），
  // 作为**面板内的局部开关**本就不该有全局键位：正则开关在没打开查找
  // 面板时按下去毫无意义，正则开着又去敲终端还会误判。
  // 如需恢复，加回这里 + `HeaderActions` 的 handler + 设置页映射即可。
  // M = MaxiMize。
  toggleMaximize: "Ctrl+Shift+M",

  // ---- 工具 ----
  // S = SFTP / Secure。
  openSftp: "Ctrl+Shift+S",
  devtools: "F12",

  // ---- 终端右键菜单专属 ----
  // 这两项只在 `terminalContextMenu` 里出现（应用菜单不重复列），
  // 但按键处理仍走 AppHeader 的同一张表。
  // T = Terminal 的 reconnect。
  // ⚠️ 不用更顺口的 R：那已经是「导入会话」（Restore from file）；
  // Ctrl+Shift+T 在浏览器里是「恢复刚关的标签」，终端里没有这个概念，
  // 且这层抢不到 —— 冲突检查会直接拦住重复键位。
  reconnect: "Ctrl+Shift+T",
  // F = Fullscreen / 专注模式（隐藏侧栏、标签条、状态栏）。
  // ⚠️ 不用 Ctrl+F：那是查找。
  toggleFocusMode: "Ctrl+Shift+F"
};

/** 菜单里可以显示键位的项（即本表覆盖到的），供自检用。 */
export function shortcutOf(
  actionId: string
): string | undefined {
  return effectiveShortcuts()[actionId];
}

/**
 * SFTP 窗口自己的快捷键表（默认出厂键位）。
 *
 * 与终端窗口的 `APP_SHORTCUTS` 分开：两边的动作互不相干，设置页也按
 * 「终端窗口 / SFTP 窗口」两段分别展示。覆盖仍存同一张 `overrides`
 * （动作 id 全局不重复），生效合并见下方 store。
 *
 * 键位串里的主键用 `event.key` 的原名（ArrowLeft 等），归一化会保留
 * 这类「命名键」的大小写，不会变成 ARROWLEFT。
 */
export const SFTP_SHORTCUTS: Record<
  string,
  string
> = {
  // 文件列表后退 / 前进：沿资源管理器习惯用 Alt+方向键
  sftpGoBack: "Alt+ArrowLeft",
  sftpGoForward: "Alt+ArrowRight"
};

/**
 * 快捷键的生效范围：设置页按它分成「终端窗口 / SFTP 窗口」两段。
 *
 * ⚠️ 这里是**按生效窗口**分（用户 2026-10 要求），与早年按「文件 /
 * 编辑 / 查看」分五段被否是两回事 —— 那次反对的是把一张表切碎，
 * 这次是两张表本来就有不同的生效窗口，分开展示是信息不是噪音。
 */
export type ShortcutScope = "terminal" | "sftp";

export function shortcutScope(
  actionId: string
): ShortcutScope {
  return actionId in SFTP_SHORTCUTS
    ? "sftp"
    : "terminal";
}

/**
 * 动作 id 的展示名（设置页与冲突提示用）。
 *
 * ⚠️ 这里给英文 fallback：i18n 字典在 settings 域，而本文件在 shared 域
 * —— shared 不该反向依赖 settings 的翻译表。设置页渲染时会用自己的
 * i18n 键覆盖显示，这里的英文只用于冲突提示这类兜底文案。
 */
export const ACTION_LABELS: Record<
  string,
  string
> = {
  newSession: "New session",
  openLocal: "Open local session",
  exportSessions: "Export sessions",
  importSessions: "Import sessions",
  closeActive: "Close session",
  quit: "Quit",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select all",
  clear: "Clear",
  find: "Find",
  toggleMaximize: "Maximize / restore",
  openSftp: "Open SFTP",
  devtools: "Developer tools",
  reconnect: "Reconnect",
  toggleFocusMode: "Fullscreen",
  sftpGoBack: "SFTP back",
  sftpGoForward: "SFTP forward"
};

/**
 * ⚠️ 这里曾有一个 `ACTION_GROUPS`（按「文件 / 编辑 / 查看 / 工具 /
 * 终端右键菜单」分五段），快捷键设置页与右键菜单都按它渲染。用户要求
 * **取消分版块**（理由：五个小标题把列表切碎，找一个动作要先判断它在
 * 哪个版块，比平铺扫一遍更慢），已删除。
 *
 * 现在动作的展示顺序 = `Object.keys(APP_SHORTCUTS)` 的声明顺序，
 * 顺序本身就是「会话 → 编辑 → 查找 → 工具 → 终端上下文」的顺序。
 * 要再分组时，先想清楚是不是又在给查找加成本。
 */

/**
 * **可重新分配的动作** = 默认表里的全部动作。
 *
 * ⚠️ 别再把 `find` / `devtools` 排除掉（曾经排除过，理由是它们在
 * `useTerminals` 里硬编码）。现在 `useTerminals` 的两处硬编码都改成
 * 读本表的**生效表**了，所以它们一样能改。
 *
 * 这里仍然只标记「谁在别处实现」——`HANDLED_ELSEWHERE` 管的是
 * **别处实现**（防止同一次按键触发两遍），与**能不能改**是两件事，
 * 别再混用。
 */
export const CUSTOMIZABLE_ACTIONS: Set<string> =
  new Set([
    ...Object.keys(APP_SHORTCUTS),
    ...Object.keys(SFTP_SHORTCUTS)
  ]);

/**
 * 判断某个动作是不是由别处（`useTerminals`）处理的。
 *
 * `AppHeader` 的按键处理要跳过它们，否则一次按键触发两遍动作。
 * ⚠️ 这**不代表不可自定义** —— `useTerminals` 读的是同一张生效表，
 * 用户改了键位那边照样生效。
 */
export function handledElsewhere(
  actionId: string
): boolean {
  return HANDLED_ELSEWHERE.has(actionId);
}

/** 解析键位串成结构化形式；无法解析返回 null。 */
export type Chord = {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

/**
 * 功能键与方向键这类「命名键」的识别：键名不统一大小写，而是走
 * `canonicalKey` 规范成标准写法（F12 / ArrowLeft）。
 */
const NAMED_KEY = /^(f\d{1,2}|arrow\w+)$/i;

/** 命名键的显示符号：给人看的是「←」，不是「ArrowLeft」。 */
const KEY_SYMBOLS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓"
};

/** 把命名键规范成标准大小写：`f12 → F12`、`arrowleft → ArrowLeft`。 */
function canonicalKey(key: string): string {
  if (/^f\d{1,2}$/i.test(key))
    return key.toUpperCase();
  if (/^arrow/i.test(key)) {
    const rest = key.slice(5);
    return (
      "Arrow" +
      rest.charAt(0).toUpperCase() +
      rest.slice(1).toLowerCase()
    );
  }
  return key;
}

export function parseChord(
  chord: string
): Chord | null {
  const parts = chord
    .split("+")
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop() ?? "";
  if (!key) return null;
  const lower = key.toLowerCase();
  return {
    // F12 / ArrowLeft 这类命名键原样保留；字母键统一小写便于比对
    key: NAMED_KEY.test(key) ? key : lower,
    ctrl: parts.some(p =>
      /^(ctrl|control)$/i.test(p)
    ),
    shift: parts.some(
      p => p.toLowerCase() === "shift"
    ),
    alt: parts.some(
      p => p.toLowerCase() === "alt"
    )
  };
}

/** 键盘事件的最小形状：方便单测构造，也避免绑 DOM 类型。 */
export type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Mac 上 meta（Cmd）与 ctrl 等价，取二者任一。 */
  metaKey?: boolean;
};

/**
 * 事件是否命中某个键位。
 *
 * ⚠️ **shift 必须精确相等**：这样 `Ctrl+Shift+N` 不会被裸 `Ctrl+N`
 * 误命中，反之亦然。这两个组合在部分终端/桌面环境里是同一个物理键位，
 * 用「包含」判定会让两者互相打架。
 */
export function matchChord(
  event: KeyEventLike,
  chord: Chord
): boolean {
  const ctrl = event.ctrlKey || !!event.metaKey;
  if (ctrl !== chord.ctrl) return false;
  if (event.shiftKey !== chord.shift)
    return false;
  if (event.altKey !== chord.alt) return false;
  // 命名键两边都规范成标准键名再比，容忍手改文件的小写变体
  const target = canonicalKey(chord.key);
  const actual = NAMED_KEY.test(event.key)
    ? canonicalKey(event.key)
    : event.key.toLowerCase();
  return actual === target;
}

/** 便捷入口：事件命中该动作的**生效**键位则返回动作 id，否则 null。 */
export function matchAction(
  event: KeyEventLike,
  actionId: string
): string | null {
  const chord = effectiveShortcuts()[actionId];
  if (!chord) return null;
  const parsed = parseChord(chord);
  if (!parsed) return null;
  return matchChord(event, parsed)
    ? actionId
    : null;
}

// ---------------------------------------------------------------------------
// 用户覆盖：默认表 + 用户改过的部分 = 生效表
// ---------------------------------------------------------------------------

/**
 * 用户自定义的键位：`动作 id → 键位串`。只存**与默认不同的**那些。
 *
 * 存差异而不是全量，是为了以后给某个动作换默认键位时，老用户不会被
 * 静默改回去 —— 他没主动设过就跟随新默认，设过的一直按自己那套。
 */
export type ShortcutOverrides = Record<
  string,
  string
>;

/** 模块级 store：生效键位。与 i18n 同一套订阅模式。 */
let overrides: ShortcutOverrides = {};
let effective: Record<string, string> = {
  ...APP_SHORTCUTS,
  ...SFTP_SHORTCUTS
};
const listeners = new Set<() => void>();

/**
 * 取当前生效的键位表（默认 + 用户覆盖）。
 *
 * ⚠️ 返回的是**模块级同一个对象引用**，只在覆盖变化时换新。
 * `matchChord` 每次按键都要查表，热点路径上不能每次新建对象。
 */
export function effectiveShortcuts(): Record<
  string,
  string
> {
  return effective;
}

/** 取用户覆盖的原样副本（落盘用）。 */
export function getShortcutOverrides(): ShortcutOverrides {
  return { ...overrides };
}

/**
 * 写入用户覆盖并通知订阅者。
 *
 * 传空对象 = 全部恢复默认。非法键位串（解析不出主键）在读入时就该
 * 被 `sanitizeOverrides` 剔掉，这里再做一次是防手改设置文件。
 */
export function setShortcutOverrides(
  next: ShortcutOverrides
): void {
  const clean = sanitizeOverrides(next);
  if (
    JSON.stringify(clean) ===
    JSON.stringify(overrides)
  )
    return;
  overrides = clean;
  const merged: Record<string, string> = {
    ...APP_SHORTCUTS,
    ...SFTP_SHORTCUTS
  };
  for (const [id, chord] of Object.entries(
    overrides
  )) {
    // 只覆盖「可自定义且默认表里有」的动作：
    // 顺手挡掉手改文件塞进来的未知 id
    if (
      CUSTOMIZABLE_ACTIONS.has(id) &&
      (APP_SHORTCUTS[id] ?? SFTP_SHORTCUTS[id])
    )
      merged[id] = chord;
  }
  effective = merged;
  for (const listener of listeners) listener();
}

/**
 * 清洗用户覆盖：丢掉不可自定义的动作、解析不了的键位串、
 * 以及与其它动作撞车的（保留先出现的那个）。
 *
 * 撞车必须在读入时就解决：两个动作共用一个键位时，按键处理按表序
 * 只触发第一个，第二个就成了「按了没反应」的假功能。
 */
export function sanitizeOverrides(
  raw: unknown
): ShortcutOverrides {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  )
    return {};
  const result: ShortcutOverrides = {};
  const taken = new Set<string>();
  for (const [id, chord] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!CUSTOMIZABLE_ACTIONS.has(id)) continue;
    if (typeof chord !== "string") continue;
    // 归一化后再比较：`ctrl+shift+n` 与 `Ctrl+Shift+N` 是同一个键
    const normalized = normalizeChord(chord);
    if (!normalized) continue;
    if (taken.has(normalized)) continue;
    // ⚠️ 别名也占位：用户把某动作设成 `Ctrl+Shift+I`，devtools 的
    // 历史别名仍会先命中（它不在表里、不可改），那个动作就永远
    // 按不出来。宁可存不下，也不能让用户拿到一个假键位。
    if (
      normalized ===
      normalizeChord(DEVTOOLS_ALT_CHORD)
    )
      continue;
    taken.add(normalized);
    result[id] = normalized;
  }
  return result;
}

/**
 * 把键位串归一化成表里统一的写法（`Ctrl+Shift+N`）。
 *
 * 用户在设置页录的是按键事件，转出来的串可能是 `Ctrl+Shift+n`；
 * 手改设置文件也可能大小写混乱。统一后再存，冲突检查才准确。
 * 解析不出来（空串、只有修饰键）返回 null。
 */ export function normalizeChord(
  chord: string
): string | null {
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  // 功能键 / 方向键规范成标准键名，字母键统一大写显示
  parts.push(
    NAMED_KEY.test(parsed.key)
      ? canonicalKey(parsed.key)
      : parsed.key.toUpperCase()
  );
  // 光按修饰键（Ctrl+Shift+）没有主键，不成其为一个组合
  const key = parts.pop() ?? "";
  if (!key || key === "SHIFT") return null;
  parts.push(key);
  return parts.join("+");
}

/**
 * 键位串的显示形式：方向键转符号（`Alt+ArrowLeft → Alt+←`）。
 *
 * 存储与匹配始终用 `event.key` 原名（归一化、冲突检查都依赖它），
 * 只有**给人看的**地方走这里 —— 设置页的键位格子、提示气泡。
 * 没有符号映射的键（字母 / F 键）按原样显示。
 */
export function formatChord(
  chord: string
): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  const symbol =
    KEY_SYMBOLS[parsed.key.toLowerCase()];
  if (symbol) parts.push(symbol);
  else if (NAMED_KEY.test(parsed.key))
    parts.push(canonicalKey(parsed.key));
  else parts.push(parsed.key.toUpperCase());
  return parts.join("+");
}

/**
 * 找出与 `chord` 撞车的动作 id（可排除某个 id 自身）。
 *
 * 设置页改键位时实时提示「已被 XX 占用」；落盘前的最后一道防线
 * 也靠它 —— 见 `sanitizeOverrides`。
 */
export function findConflict(
  chord: string,
  exceptId?: string
): string | null {
  const normalized = normalizeChord(chord);
  if (!normalized) return null;
  const table = effectiveShortcuts();
  for (const [id, value] of Object.entries(
    table
  )) {
    if (id === exceptId) continue;
    if (normalizeChord(value) === normalized)
      return id;
  }
  // ⚠️ 表外的别名也要算：devtools 的 `Ctrl+Shift+I` 不在表里、不可改，
  // 用户把某个动作设成它，那个动作就永远按不出来（别名会先命中）。
  // 返回 "devtools" 让设置页照常提示「已被开发者工具占用」。
  if (
    exceptId !== "devtools" &&
    normalized ===
      normalizeChord(DEVTOOLS_ALT_CHORD)
  )
    return "devtools";
  return null;
}

/**
 * 快捷键录制中（设置页正在等用户按下一个组合）。
 *
 * 用**模块级计数**而不是组件状态：`AppHeader` 的按键监听挂在 window
 * 捕获阶段，根本不知道设置页里有个输入框聚焦着。录制期间用户按
 * `Ctrl+Shift+N`，那次按键必须被当成「录入」而不是「执行新建会话」。
 */
let recordingDepth = 0;

/** 标记进入 / 退出录制态（成对调用，返回值可直接给 finally 用）。 */
export function beginShortcutRecording(): () => void {
  recordingDepth += 1;
  let released = false;
  return () => {
    // 幂等：同一个 token 被 release 两次不会把计数减到负数
    if (released) return;
    released = true;
    recordingDepth = Math.max(
      0,
      recordingDepth - 1
    );
  };
}

/** 当前是否处于录制态（按键处理要让它让路）。 */
export function isRecordingShortcut(): boolean {
  return recordingDepth > 0;
}

function subscribeShortcuts(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getEffectiveSnapshot(): Record<
  string,
  string
> {
  return effective;
}

/**
 * 订阅生效键位表。
 *
 * 用 `useSyncExternalStore`（与项目里 i18n / 终端选区状态一致）：
 * 菜单标签、设置页、以及按键处理读的都是同一份，订阅者自动重渲染。
 */
export function useShortcuts(): Record<
  string,
  string
> {
  return useSyncExternalStore(
    subscribeShortcuts,
    getEffectiveSnapshot,
    getEffectiveSnapshot
  );
}

/**
 * 按键事件 → 键位串（设置页的录制输入用）。
 *
 * ⚠️ 只认「至少带一个 Ctrl/Alt」的组合，或功能键 —— 裸字母/数字键
 * 不能作为应用级快捷键（用户没法在终端里单敲一个字母不输字）。
 * 返回 null 表示这次按键不该被记下来。
 */
export function chordFromEvent(
  event: KeyEventLike
): string | null {
  // 单按修饰键是「用户正在凑组合」，不是一次完整输入
  if (
    ["Control", "Alt", "Shift", "Meta"].includes(
      event.key
    )
  )
    return null;
  const ctrl = event.ctrlKey || !!event.metaKey;
  const isFunction = NAMED_KEY.test(event.key);
  if (!ctrl && !event.altKey && !isFunction)
    return null;
  return normalizeChord(
    buildChordString(
      event.key,
      ctrl,
      event.shiftKey,
      event.altKey
    )
  );
}

function buildChordString(
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean
): string {
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  // 命名键规范成标准键名（ArrowLeft），其余统一大写
  parts.push(
    NAMED_KEY.test(key)
      ? canonicalKey(key)
      : key.toUpperCase()
  );
  return parts.join("+");
}

/**
 * 这类可编辑元素获得焦点时，应用级快捷键要让路。
 *
 * 例：AI 助手的输入框里按 `Ctrl+Shift+A` 应该是选文字，不是「终端全选」。
 * 终端（xterm）不在此列 —— 它是 `textarea` 但键位另有一套
 * （`useTerminals` 的捕获监听 + xterm 原生处理），所以只按上面的
 * 白名单式排除，不按标签名一刀切。
 */
export function isEditableTarget(
  target: EventTarget | null
): boolean {
  if (!(target instanceof HTMLElement))
    return false;
  // xterm 的辅助 textarea：交给 xterm 自己，不当普通输入框拦
  if (target.closest(".xterm-helper-textarea"))
    return false;
  if (
    target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "INPUT"
  )
    return true;
  // HeroUI / 自研组件常把可编辑区做成 div + role="textbox"
  const role = target.getAttribute("role");
  return (
    role === "textbox" || role === "searchbox"
  );
}
