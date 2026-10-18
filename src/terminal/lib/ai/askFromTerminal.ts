/**
 * 终端右键菜单 → AI 助手面板的桥。
 *
 * 终端里选中（或指针指着）一段内容，右键「解释这条 / 让 AI 看看」，
 * 内容会作为一轮提问直接发进 AI 面板；面板收起时由 TerminalWorkspace
 * 监听同一事件展开，本地会话不挂 AiPanel（无监听），菜单项据此置灰。
 *
 * 为什么用模块级事件总线而不是 prop 层层传：菜单构建在终端域
 * （terminalContextMenu），面板在 AI 域（AiPanel），两者隔着
 * useTerminals / TerminalWorkspace 两层，为两个菜单项开一条 prop 链
 * 不值当；总线只有两个订阅方，语义就是「终端问 AI 一句话」。
 */
import type { Terminal } from "@xterm/xterm";

/**
 * 送进面板的终端内容上限。
 *
 * 用户在终端里 Ctrl+A 式全选再右键的场景不能把上下文撑爆 —— 截断并
 * 注明原始长度，让模型知道看到的是片段。
 */
export const ASK_TEXT_LIMIT = 8000;

/** 两个预设问法：标签给菜单用，prompt 给面板用（单一出处，两边不会漂）。 */
export const AI_ASK_PRESETS = {
  explain: {
    label: "解释这条",
    prompt: (text: string) =>
      `请解释下面这段终端内容：\n\n${text}`
  },
  diagnose: {
    label: "让 AI 看看",
    prompt: (text: string) =>
      `请看看下面这段终端输出，指出存在的问题并给出处理建议：\n\n${text}`
  }
} as const;

export type AiAskPreset =
  keyof typeof AI_ASK_PRESETS;

/** 一次「终端问 AI」的载荷：预设问法 + 要问的文本（已裁剪）。 */
export type AiAsk = {
  preset: AiAskPreset;
  text: string;
};

type AiAskListener = (ask: AiAsk) => void;

const listeners = new Set<AiAskListener>();

/**
 * 当前有没有面板在听。
 *
 * 菜单每次弹出时查它决定两项的置灰 —— 本地会话不挂 AiPanel，置灰的
 * 菜单项好过「点了没反应」。
 */
export function hasAiAskListener(): boolean {
  return listeners.size > 0;
}

/** 订阅「终端问 AI」；返回退订函数（AiPanel 卸载时用）。 */
export function onAiAsk(
  listener: AiAskListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 把终端内容作为提问送进 AI 面板。
 *
 * @returns false = 没有面板在听或内容为空（调用方不应有副作用）
 */
export function askAiFromTerminal(
  preset: AiAskPreset,
  text: string
): boolean {
  const trimmed = text.trim();
  if (!trimmed || listeners.size === 0)
    return false;
  const clipped =
    trimmed.length > ASK_TEXT_LIMIT
      ? `${trimmed.slice(0, ASK_TEXT_LIMIT)}\n…（内容过长已截断，原始 ${trimmed.length} 字符）`
      : trimmed;
  for (const listener of listeners)
    listener({ preset, text: clipped });
  return true;
}

/**
 * 指针的 clientY → 可见缓冲行号。
 *
 * 与 terminalSelection 的 locateMouse 同一套算法（按屏幕高度均分rows、
 * 钳进行范围），抽成纯函数是为了能单测 —— 坐标算错的表现是「右键
 * 取到了隔壁行的内容」，不钉住迟早复发。
 *
 * @param screenRect .xterm-screen 的边界矩形
 * @param viewportY 视口顶端在缓冲里的行号（0 = 没有回滚）
 */
export function pointerRow(
  terminal: Terminal,
  event: { clientY: number },
  screenRect: { top: number; height: number },
  viewportY: number
): number | undefined {
  if (!screenRect.height) return undefined;
  const row = Math.floor(
    ((event.clientY - screenRect.top) /
      screenRect.height) *
      terminal.rows
  );
  return (
    viewportY +
    Math.max(0, Math.min(terminal.rows - 1, row))
  );
}

/**
 * 取「要问 AI 的文本」：有选区用选区（跨回滚区也照拿），否则用指针
 * 所在行的文字。两头都空返回空串 —— 菜单项据此置灰。
 */
export function resolveAskText(
  terminal: Terminal,
  event: {
    clientX: number;
    clientY: number;
  }
): string {
  const selection = terminal.getSelection();
  if (selection.trim()) return selection;
  const screen =
    terminal.element?.querySelector<HTMLElement>(
      ".xterm-screen"
    );
  if (!screen) return "";
  const rect = screen.getBoundingClientRect();
  const row = pointerRow(
    terminal,
    event,
    rect,
    terminal.buffer.active.viewportY
  );
  if (row === undefined) return "";
  return (
    terminal.buffer.active
      .getLine(row)
      ?.translateToString(true) ?? ""
  );
}
