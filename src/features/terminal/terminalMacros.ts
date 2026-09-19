/**
 * 终端快捷宏：把常用命令存下来，做成按钮一点即执行。
 *
 * 存文件（键 `macros`）—— 宏是纯本地偏好，跟着人走而不是跟着项目走。
 */

import {
  clearData,
  DataName,
  readData,
  writeData
} from "@/features/settings/storage";

/** 一条快捷宏。 */
export type TerminalMacro = {
  /** 稳定标识，用于列表 key 与增删改定位 */
  id: string;
  /** 按钮上显示的名字；留空时退化为命令本身 */
  name: string;
  /** 实际写入终端的内容（不含结尾回车，执行时补） */
  command: string;
};

/**
 * 首次使用时给几条通用示例，让用户一眼看懂这个东西怎么用。
 *
 * 刻意都选只读命令：新用户最容易在没看清的情况下一键执行，
 * 示例不该带来任何副作用。
 */
const DEFAULT_MACROS: TerminalMacro[] = [
  {
    id: "default-pwd",
    name: "当前目录",
    command: "pwd"
  },
  {
    id: "default-ls",
    name: "列出文件",
    command: "ls -al"
  },
  {
    id: "default-git",
    name: "Git 状态",
    command: "git status"
  },
  {
    id: "default-clear",
    name: "清屏",
    command: "clear"
  }
];

/** 生成一个新的宏 id。 */
export function createMacroId(): string {
  return `macro-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * 读取快捷宏列表。
 *
 * 任何一步出错（没存过、JSON 坏了、结构不对）都退回默认示例 ——
 * 这份数据丢了不致命，但不该让终端区因为读不到宏而整个挂掉。
 */
export function loadMacros(): TerminalMacro[] {
  try {
    const raw = readData(DataName.macros);
    if (!raw) return DEFAULT_MACROS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed))
      return DEFAULT_MACROS;
    const macros = parsed.filter(
      (item): item is TerminalMacro =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as TerminalMacro).id ===
          "string" &&
        typeof (item as TerminalMacro).name ===
          "string" &&
        typeof (item as TerminalMacro).command ===
          "string"
    );
    return macros;
  } catch {
    return DEFAULT_MACROS;
  }
}

/** 保存快捷宏列表；写盘失败只记日志，不影响使用。 */
export function saveMacros(
  macros: TerminalMacro[]
): void {
  writeData(
    DataName.macros,
    JSON.stringify(macros)
  );
}

/** 抹掉已保存的宏，下次读取即回到内置示例。 */
export function clearMacros(): void {
  clearData(DataName.macros);
}
