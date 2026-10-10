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
 */

/**
 * 这几个键位在别处已实现（`useTerminals` 的挂载期 window 捕获监听），
 * 不在 `AppHeader` 重复绑定 —— 否则同一次按键会触发两遍
 * （`openSearch` 被调两次）。它们仍留在表里，菜单要显示。
 */
const HANDLED_ELSEWHERE = new Set([
  "find",
  "devtools"
]);

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
  // C = Case。⚠️ 不用裸 Ctrl+Shift+C：Linux 桌面习惯里那是「复制」。
  toggleCaseSensitive: "Ctrl+Shift+C",
  // G = reGex。Ctrl+Shift+G 常规上是「运行任务」，这里让给正则开关。
  toggleRegex: "Ctrl+Shift+G",
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
  return APP_SHORTCUTS[actionId];
}

/**
 * 判断某个动作是不是由别处（`useTerminals`）处理的。
 *
 * `AppHeader` 的按键处理要跳过它们，否则一次按键触发两遍动作。
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
    // F12 这类功能键原样保留；字母键统一小写便于比对
    key: /^f\d{1,2}$/i.test(key) ? key : lower,
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
  const target = chord.key;
  const actual = /^f\d{1,2}$/i.test(event.key)
    ? event.key
    : event.key.toLowerCase();
  return actual === target;
}

/** 便捷入口：事件命中该动作的键位则返回动作 id，否则 null。 */
export function matchAction(
  event: KeyEventLike,
  actionId: string
): string | null {
  const chord = APP_SHORTCUTS[actionId];
  if (!chord) return null;
  const parsed = parseChord(chord);
  if (!parsed) return null;
  return matchChord(event, parsed)
    ? actionId
    : null;
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
