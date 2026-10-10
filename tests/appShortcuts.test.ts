/**
 * 应用级快捷键表。
 *
 * 两个要防的回归：
 *
 * 1. **别抢 shell 的行编辑键**：裸 `Ctrl+<字母>` 几乎全被 readline /
 *    emacs 键位占用（Ctrl+A/E/K/U/W/L/R/P/N…）。所以应用级动作一律用
 *    `Ctrl+Shift+X`，只有 `PLAIN_CTRL_OK` 里那三个有意保留（Ctrl+C/V/F）。
 * 2. **匹配不能串**：`Ctrl+Shift+N` 与 `Ctrl+N` 在部分环境是同一物理
 *    键位，用「包含」判定会互相打架，所以 shift 必须精确相等。
 */

import { describe, it, expect } from "vitest";
// 直接把源码当文本导入：`?raw` 走 vite 的原始字符串加载，
// 不需要 @types/node（项目没装，走 node:fs 会 TS2307）
import contextMenuSource from "@/terminal/lib/terminalContextMenu.ts?raw";
import {
  APP_SHORTCUTS,
  matchAction,
  matchChord,
  parseChord
} from "@/shared/lib/appShortcuts";

/** 构造一个键盘事件。 */
function keyEvent(
  key: string,
  modifiers: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  } = {}
): {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
} {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false
  };
}

/** 取出表里所有「裸 Ctrl+单字母」的键位字母（小写、已排序）。 */
function plainCtrlLetters(): string[] {
  return Object.values(APP_SHORTCUTS)
    .filter(chord => /^ctrl\+[a-z]$/i.test(chord))
    .map(chord => chord.slice(-1).toLowerCase())
    .sort();
}

/**
 * **有意保留的裸 Ctrl 动作**及其字母。
 *
 * 三个，各有理由：
 * - `copy` / `paste`：xterm / 浏览器原生处理。终端里有选区时 Ctrl+C 走复制，
 *   没选区时必须是 SIGINT —— 改成全局绑定反而把中断功能抢走。
 * - `find`：查找功能的标准键位，且**已由 `useTerminals` 实现**，改键位等于
 *   改既有行为。它在 readline 里是「向前一个字符」，但本项目的查找优先。
 *
 * ⚠️ 别把这个集合当「可以随便加」的先例：新动作一律走 `Ctrl+Shift+X`。
 */
const PLAIN_CTRL_OK: Record<string, string> = {
  copy: "c",
  paste: "v",
  find: "f"
};

describe("parseChord", () => {
  it("拆出修饰键与主键", () => {
    expect(parseChord("Ctrl+Shift+N")).toEqual({
      key: "n",
      ctrl: true,
      shift: true,
      alt: false
    });
  });

  it("功能键保留原大小写", () => {
    expect(parseChord("F12")?.key).toBe("F12");
  });

  it("单键也算合法键位", () => {
    expect(parseChord("Escape")).toEqual({
      key: "escape",
      ctrl: false,
      shift: false,
      alt: false
    });
  });

  it("空串返回 null", () => {
    expect(parseChord("")).toBeNull();
  });
});

describe("matchChord", () => {
  const chord = parseChord("Ctrl+Shift+N")!;

  it("组合完全一致才命中", () => {
    expect(
      matchChord(
        keyEvent("n", {
          ctrl: true,
          shift: true
        }),
        chord
      )
    ).toBe(true);
  });

  it("少一个修饰键就不命中", () => {
    expect(
      matchChord(
        keyEvent("n", { ctrl: true }),
        chord
      )
    ).toBe(false);
  });

  it("多一个修饰键也不命中", () => {
    expect(
      matchChord(
        keyEvent("n", {
          ctrl: true,
          shift: true,
          alt: true
        }),
        chord
      )
    ).toBe(false);
  });

  it("大小写无关", () => {
    expect(
      matchChord(
        keyEvent("N", {
          ctrl: true,
          shift: true
        }),
        chord
      )
    ).toBe(true);
  });

  it("meta（Mac 的 Cmd）视同 ctrl", () => {
    expect(
      matchChord(
        {
          ...keyEvent("n", {
            shift: true
          }),
          metaKey: true
        },
        chord
      )
    ).toBe(true);
  });
});

describe("APP_SHORTCUTS 表", () => {
  it("裸 Ctrl 只有 copy/paste/find 三个，且值正确", () => {
    expect(plainCtrlLetters()).toEqual([
      "c",
      "f",
      "v"
    ]);
    expect(APP_SHORTCUTS.copy).toBe("Ctrl+C");
    expect(APP_SHORTCUTS.paste).toBe("Ctrl+V");
    expect(APP_SHORTCUTS.find).toBe("Ctrl+F");
  });

  it("没有裸 Ctrl 占用 readline 的行编辑键", () => {
    // readline / emacs 常用的裸 Ctrl 字母键，除了上面三个有意保留的
    // （C=中断/复制、V=粘贴、F=查找）之外，一个都不能占
    const shellReserved = [
      "a",
      "b",
      "d",
      "e",
      "g",
      "k",
      "l",
      "n",
      "o",
      "p",
      "r",
      "t",
      "u",
      "w",
      "z"
    ];
    const allowed = new Set(
      Object.values(PLAIN_CTRL_OK)
    );
    const taken = new Set(
      plainCtrlLetters().filter(
        letter => !allowed.has(letter)
      )
    );
    for (const letter of shellReserved) {
      expect(
        taken.has(letter),
        `Ctrl+${letter} 被占用了`
      ).toBe(false);
    }
  });

  it("每个动作都用上 Shift 或功能键（应用级动作不裸奔）", () => {
    for (const [id, chordStr] of Object.entries(
      APP_SHORTCUTS
    )) {
      const isPlain = /^ctrl\+[a-z]$/i.test(
        chordStr
      );
      if (!isPlain) continue;
      expect(
        PLAIN_CTRL_OK[id],
        `${id} 用了裸 Ctrl（${chordStr}），` +
          "会抢远端 shell 的行编辑键；" +
          "新动作请走 Ctrl+Shift+X"
      ).toBe(chordStr.slice(-1).toLowerCase());
    }
  });

  it("键位字符串都能解析", () => {
    for (const [id, chordStr] of Object.entries(
      APP_SHORTCUTS
    )) {
      expect(
        parseChord(chordStr),
        `${id} 的键位 ${chordStr} 无法解析`
      ).not.toBeNull();
    }
  });

  it("不存在重复键位（同一个键不能映射两个动作）", () => {
    const seen = new Map<string, string>();
    for (const [id, chordStr] of Object.entries(
      APP_SHORTCUTS
    )) {
      const previous = seen.get(chordStr);
      expect(
        previous,
        `${previous} 与 ${id} 都绑了 ${chordStr}`
      ).toBeUndefined();
      seen.set(chordStr, id);
    }
  });

  it("菜单与终端右键菜单用到的动作都登记了键位", () => {
    // 菜单里出现的每个 id 都要有键位，否则菜单右侧留白不好看
    // （openSettings 不在任何菜单里 —— 设置入口是竖条底部的齿轮）
    for (const id of [
      // 应用菜单
      "newSession",
      "openLocal",
      "exportSessions",
      "importSessions",
      "closeActive",
      "quit",
      "copy",
      "paste",
      "selectAll",
      "clear",
      "find",
      "toggleCaseSensitive",
      "toggleRegex",
      "toggleMaximize",
      "openSftp",
      "devtools",
      // 终端右键菜单（terminalContextMenu 里的 makeItem 传这些 id）
      "reconnect",
      "toggleFocusMode"
    ]) {
      expect(
        APP_SHORTCUTS[id],
        `${id} 没有登记快捷键`
      ).toBeTruthy();
    }
  });
});

describe("terminalContextMenu 的键位来源", () => {
  /**
   * 右键菜单的 `<kbd>` 必须由 `shortcutOf(id)` 从表里取。
   * 这里读源码断言「菜单里出现的是 id 而不是硬编码键位串」——
   * 改回手写 `makeItem("复制", "Ctrl+C", …)` 会立刻失败。
   *
   * ⚠️ 用 `?raw` 而不是 `node:fs/promises`：项目没装 `@types/node`
   * （记忆里已记这条），走 fs 会直接 TS2307。
   */
  const source = contextMenuSource;

  it("makeItem 的第二参是动作 id，不是硬编码键位串", () => {
    expect(source).toContain(
      'from "@/shared/lib/appShortcuts"'
    );
    expect(source).toContain("shortcutOf(");
    // 旧的硬编码：标签后面直接跟 "Ctrl+xxx"
    expect(source).not.toMatch(
      /makeItem\(\s*"[^"]+",\s*"Ctrl/
    );
    // 每个带键位的项都必须传表里的 id
    for (const id of [
      "copy",
      "paste",
      "find",
      "reconnect",
      "clear",
      "toggleFocusMode"
    ]) {
      expect(
        source,
        `右键菜单里的 ${id} 没有走 shortcutOf`
      ).toContain(`"${id}"`);
    }
  });

  it("日志子菜单不登记全局快捷键（子菜单项无键位）", () => {
    // 日志子菜单的 add() 一律传空串 id
    expect(source).toContain(
      'const item = makeItem(label, "", icon);'
    );
    expect(
      APP_SHORTCUTS.logStart
    ).toBeUndefined();
  });
});

describe("matchAction", () => {
  it("按真实按键返回对应动作 id", () => {
    expect(
      matchAction(
        keyEvent("n", {
          ctrl: true,
          shift: true
        }),
        "newSession"
      )
    ).toBe("newSession");
  });

  it("Ctrl+F 命中 find", () => {
    expect(
      matchAction(
        keyEvent("f", { ctrl: true }),
        "find"
      )
    ).toBe("find");
  });

  it("F12 命中 devtools（不带修饰键）", () => {
    expect(
      matchAction(keyEvent("F12"), "devtools")
    ).toBe("devtools");
  });

  it("未登记的动作返回 null", () => {
    expect(
      matchAction(
        keyEvent("z", {
          ctrl: true,
          shift: true
        }),
        "nothing"
      )
    ).toBeNull();
  });

  it("Ctrl+Shift+N 不会被当成裸 Ctrl+N", () => {
    // 锁的是 matchChord 的「shift 必须精确相等」：若改成包含判定，
    // 未来有人给某动作绑了裸 Ctrl+N，这里会立刻炸
    const plainN = Object.entries(
      APP_SHORTCUTS
    ).find(
      ([, chord]) =>
        chord.toLowerCase() === "ctrl+n"
    );
    expect(plainN).toBeUndefined();
    expect(
      matchAction(
        keyEvent("n", { ctrl: true }),
        "newSession"
      )
    ).toBeNull();
  });
});
