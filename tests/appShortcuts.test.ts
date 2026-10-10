/**
 * 应用级快捷键表。
 *
 * 三个要防的回归：
 *
 * 1. **别抢 shell 的行编辑键**：裸 `Ctrl+<字母>` 几乎全被 readline /
 *    emacs 键位占用（Ctrl+A/E/K/U/W/L/R/P/N…）。所以应用级动作一律用
 *    `Ctrl+Shift+X`，只有 `PLAIN_CTRL_OK` 里那三个有意保留（Ctrl+C/V/F）。
 * 2. **匹配不能串**：`Ctrl+Shift+N` 与 `Ctrl+N` 在部分环境是同一物理
 *    键位，用「包含」判定会互相打架，所以 shift 必须精确相等。
 * 3. **用户自定义不能造出坏状态**：改了键位之后菜单要跟着变、
 *    撞车的键位要被挡掉、`find`/`devtools` 不该被改成假键位。
 */

import {
  describe,
  it,
  expect,
  beforeEach
} from "vitest";
// 直接把源码当文本导入：`?raw` 走 vite 的原始字符串加载，
// 不需要 @types/node（项目没装，走 node:fs 会 TS2307）
import contextMenuSource from "@/terminal/lib/terminalContextMenu.ts?raw";
import appHeaderSource from "@/app/components/AppHeader.tsx?raw";
import appRailSource from "@/app/components/AppRail.tsx?raw";
import useTerminalsSource from "@/terminal/lib/useTerminals.ts?raw";
import shortcutSettingsSource from "@/settings/components/ShortcutSettings.tsx?raw";
import appSource from "@/app/components/App.tsx?raw";
import * as appShortcutsModule from "@/shared/lib/appShortcuts";
import {
  APP_SHORTCUTS,
  beginShortcutRecording,
  chordFromEvent,
  CUSTOMIZABLE_ACTIONS,
  DEVTOOLS_ALT_CHORD,
  effectiveShortcuts,
  findConflict,
  handledElsewhere,
  isRecordingShortcut,
  matchAction,
  matchChord,
  normalizeChord,
  parseChord,
  sanitizeOverrides,
  setShortcutOverrides,
  shortcutOf
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

describe("用户自定义快捷键：生效表", () => {
  // store 是模块级的，每个用例开头必须复位，否则相互污染
  beforeEach(() => setShortcutOverrides({}));

  it("初始生效表等于默认表", () => {
    expect(effectiveShortcuts()).toEqual(
      APP_SHORTCUTS
    );
    expect(shortcutOf("newSession")).toBe(
      APP_SHORTCUTS.newSession!
    );
  });

  it("覆盖后 matchAction 按新键位命中、旧键位失效", () => {
    setShortcutOverrides({
      newSession: "Ctrl+Alt+N"
    });
    expect(
      matchAction(
        keyEvent("n", {
          ctrl: true,
          alt: true
        }),
        "newSession"
      )
    ).toBe("newSession");
    // 旧键位不该再命中 —— 否则菜单显示新键位、按旧键位却还有反应
    expect(
      matchAction(
        keyEvent("n", {
          ctrl: true,
          shift: true
        }),
        "newSession"
      )
    ).toBeNull();
  });

  it("传空对象 = 全部恢复默认", () => {
    setShortcutOverrides({
      newSession: "Ctrl+Alt+N"
    });
    setShortcutOverrides({});
    expect(shortcutOf("newSession")).toBe(
      APP_SHORTCUTS.newSession
    );
  });

  it("大小写不同的同一个键位不会被当成两回事", () => {
    // 存进来归一化，比较时才能认出撞车
    setShortcutOverrides({
      newSession: "ctrl+alt+n"
    });
    expect(shortcutOf("newSession")).toBe(
      "Ctrl+Alt+N"
    );
  });

  it("find / devtools 也能自定义（useTerminals 读的是同一张生效表）", () => {
    // 这两项由 useTerminals 执行（AppHeader 因 handledElsewhere 跳过），
    // 但那边读的也是生效表 —— 所以改了照样生效。
    // （曾经把它们排除在外，理由是「那边硬编码了」——已改成读表）
    expect(CUSTOMIZABLE_ACTIONS.has("find")).toBe(
      true
    );
    expect(
      CUSTOMIZABLE_ACTIONS.has("devtools")
    ).toBe(true);
    setShortcutOverrides({
      find: "Ctrl+Alt+F"
    });
    expect(shortcutOf("find")).toBe("Ctrl+Alt+F");
  });

  it("CUSTOMIZABLE_ACTIONS 覆盖默认表全部动作", () => {
    for (const id of Object.keys(APP_SHORTCUTS)) {
      expect(
        CUSTOMIZABLE_ACTIONS.has(id),
        `${id} 不该被排除在可自定义之外`
      ).toBe(true);
    }
  });

  it("只有默认真认存在的动作能被覆盖", () => {
    setShortcutOverrides({
      notAnAction: "Ctrl+Alt+Z",
      find: "Ctrl+Alt+F"
    });
    expect(
      shortcutOf("notAnAction")
    ).toBeUndefined();
    // 表里存在的照常覆盖
    expect(shortcutOf("find")).toBe("Ctrl+Alt+F");
  });

  it("生效表对象引用在覆盖不变时保持稳定（按键热路径不能每次新建）", () => {
    const before = effectiveShortcuts();
    // 内容相同 → setShortcutOverrides 早退，不该换引用
    setShortcutOverrides({});
    expect(effectiveShortcuts()).toBe(before);
    setShortcutOverrides({
      newSession: "Ctrl+Alt+N"
    });
    expect(effectiveShortcuts()).not.toBe(before);
  });

  it("ACTION_GROUPS 已移除：取消分版块后不再有分组数据", () => {
    // 用户报「取消分版块」（文件/编辑/查看/工具 那五段）。
    // ⚠️ 这条是**反向断言**：防止有人看到列表变长又把分组加回来 ——
    // 分组看起来更整齐，但 16 项切成五段后找一个动作反而更慢。
    expect(
      (
        appShortcutsModule as unknown as Record<
          string,
          unknown
        >
      ).ACTION_GROUPS
    ).toBeUndefined();
    // 设置页必须按默认表的声明顺序平铺（该顺序即分组顺序）
    expect(shortcutSettingsSource).toContain(
      "Object.keys(DEFAULT_SHORTCUTS)"
    );
    // 分组标题的样式与文案都不该残留
    expect(shortcutSettingsSource).not.toContain(
      "shortcut-group"
    );
    expect(shortcutSettingsSource).not.toContain(
      "GroupTitle"
    );
  });

  it("查找面板的两个开关不再有全局快捷键", () => {
    // 用户报「快捷键取消区分大小写，正则表达式」。它们作为**面板内的
    // 局部开关**本就不该占全局键位：查找面板没打开时按 Ctrl+Shift+G
    // 毫无意义，正则开着又去敲终端还会误判。
    // ⚠️ 反向断言：防止有人看到「查找面板有这两个按钮」就把键位加回来。
    for (const id of [
      "toggleCaseSensitive",
      "toggleRegex"
    ]) {
      expect(
        APP_SHORTCUTS[id],
        `${id} 不该再有全局快捷键`
      ).toBeUndefined();
      expect(
        shortcutSettingsSource,
        `设置页不该列出 ${id}`
      ).not.toContain(`"${id}"`);
    }
    // 查找面板自己的按钮与状态仍保留（走 terminal.find.* 文案）
    expect(appSource).toContain(
      "onToggleCaseSensitive"
    );
    expect(appSource).toContain("onToggleRegex");
  });
});

describe("sanitizeOverrides", () => {
  it("丢掉表里没有的、解析不了的、撞车的、被别名占住的项", () => {
    expect(
      sanitizeOverrides({
        newSession: "Ctrl+Alt+N",
        // 表里没有的动作
        ghost: "Ctrl+Alt+G",
        // 解析不出主键
        broken: "Ctrl+Shift+",
        // 与 newSession 撞车（大小写不同也算撞）
        openLocal: "ctrl+alt+n",
        // ⚠️ devtools 的历史别名：它不在表里但仍会先命中，
        // 用户设成这个键的动作会永远按不出来 → 直接拒收
        quit: DEVTOOLS_ALT_CHORD,
        closeActive: "Ctrl+Alt+Q"
      })
    ).toEqual({
      newSession: "Ctrl+Alt+N",
      closeActive: "Ctrl+Alt+Q"
    });
  });

  it("别名的大小写变体同样拒收", () => {
    expect(
      sanitizeOverrides({
        quit: "ctrl+shift+i"
      })
    ).toEqual({});
  });

  it("find / devtools 这些「在别处实现」的动作照常接受", () => {
    expect(
      sanitizeOverrides({
        find: "Ctrl+Alt+F",
        devtools: "Ctrl+Alt+J"
      })
    ).toEqual({
      find: "Ctrl+Alt+F",
      devtools: "Ctrl+Alt+J"
    });
  });

  it("非对象 / null / 数组一律当空", () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides("x")).toEqual({});
    expect(sanitizeOverrides([])).toEqual({});
    expect(sanitizeOverrides(undefined)).toEqual(
      {}
    );
  });

  it("非字符串的键位值被丢掉", () => {
    expect(
      sanitizeOverrides({
        newSession: 123,
        quit: "Ctrl+Alt+Q"
      })
    ).toEqual({ quit: "Ctrl+Alt+Q" });
  });
});

describe("normalizeChord", () => {
  it("统一成 Ctrl+Alt+Shift+KEY 的写法", () => {
    expect(normalizeChord("ctrl+n")).toBe(
      "Ctrl+N"
    );
    expect(
      normalizeChord("shift+ctrl+alt+n")
    ).toBe("Ctrl+Alt+Shift+N");
    expect(normalizeChord("Control+N")).toBe(
      "Ctrl+N"
    );
  });

  it("功能键保留 F 的大写", () => {
    expect(normalizeChord("f12")).toBe("F12");
  });

  it("只有修饰键 / 空串返回 null", () => {
    expect(normalizeChord("")).toBeNull();
    expect(
      normalizeChord("Ctrl+Shift+")
    ).toBeNull();
    expect(normalizeChord("Shift")).toBeNull();
  });
});

describe("findConflict", () => {
  beforeEach(() => setShortcutOverrides({}));

  it("找出占用该键位的动作", () => {
    expect(
      findConflict(APP_SHORTCUTS.newSession!)
    ).toBe("newSession");
  });

  it("排除自身（改自己的键位不算撞）", () => {
    expect(
      findConflict(
        APP_SHORTCUTS.newSession!,
        "newSession"
      )
    ).toBeNull();
  });

  it("大小写不同也算撞", () => {
    expect(
      findConflict("ctrl+shift+n", "other")
    ).toBe("newSession");
  });

  it("自由组合返回 null", () => {
    expect(
      findConflict("Ctrl+Alt+Shift+F9")
    ).toBeNull();
  });

  it("非法键位返回 null（不报冲突，直接不采纳）", () => {
    expect(findConflict("")).toBeNull();
  });

  it("表外的 devtools 别名也算占用", () => {
    // Ctrl+Shift+I 不在表里但仍会先命中 —— 放行等于给用户一个死键位
    expect(findConflict(DEVTOOLS_ALT_CHORD)).toBe(
      "devtools"
    );
    expect(
      findConflict(DEVTOOLS_ALT_CHORD, "devtools")
    ).toBeNull();
  });

  it("按用户改过的生效表判定，不是按默认表", () => {
    setShortcutOverrides({
      newSession: "Ctrl+Alt+N"
    });
    // 默认键位空出来了
    expect(
      findConflict(APP_SHORTCUTS.newSession!)
    ).toBeNull();
    // 新键位被占了
    expect(findConflict("Ctrl+Alt+N")).toBe(
      "newSession"
    );
  });
});

describe("chordFromEvent（设置页录制）", () => {
  it("Ctrl+Shift+N → Ctrl+Shift+N", () => {
    expect(
      chordFromEvent(
        keyEvent("n", {
          ctrl: true,
          shift: true
        })
      )
    ).toBe("Ctrl+Shift+N");
  });

  it("功能键不需要修饰键", () => {
    expect(chordFromEvent(keyEvent("F5"))).toBe(
      "F5"
    );
  });

  it("Alt 组合可以（Alt 是应用级可用的）", () => {
    expect(
      chordFromEvent(keyEvent("k", { alt: true }))
    ).toBe("Alt+K");
  });

  it("裸字母 / 数字不构成快捷键（终端里要能单敲）", () => {
    expect(
      chordFromEvent(keyEvent("k"))
    ).toBeNull();
    expect(
      chordFromEvent(keyEvent("1"))
    ).toBeNull();
  });

  it("单按修饰键返回 null（用户还在凑组合）", () => {
    for (const key of [
      "Control",
      "Shift",
      "Alt",
      "Meta"
    ]) {
      expect(
        chordFromEvent(
          keyEvent(key, { ctrl: true })
        ),
        key
      ).toBeNull();
    }
  });

  it("mac 的 meta 视同 ctrl", () => {
    expect(
      chordFromEvent({
        ...keyEvent("k"),
        metaKey: true
      })
    ).toBe("Ctrl+K");
  });
});

describe("录制态（让全局按键处理让路）", () => {
  it("进入录制后 isRecordingShortcut 为真，退出后恢复", () => {
    expect(isRecordingShortcut()).toBe(false);
    const release = beginShortcutRecording();
    expect(isRecordingShortcut()).toBe(true);
    release();
    expect(isRecordingShortcut()).toBe(false);
  });

  it("release 幂等：调两次不会把计数减到负数", () => {
    const release = beginShortcutRecording();
    release();
    release();
    release();
    // 负数会让 isRecordingShortcut 永远为真 → 所有快捷键失灵
    expect(isRecordingShortcut()).toBe(false);
    // 计数归零后仍能正常进入下一次录制
    const next = beginShortcutRecording();
    expect(isRecordingShortcut()).toBe(true);
    next();
  });

  it("嵌套录制：内层退出后外层仍在录制", () => {
    const outer = beginShortcutRecording();
    const inner = beginShortcutRecording();
    inner();
    expect(isRecordingShortcut()).toBe(true);
    outer();
    expect(isRecordingShortcut()).toBe(false);
  });
});

describe("消费方读的是生效表", () => {
  /**
   * 断言要剥掉注释再匹配：`APP_SHORTCUTS` 这个名字在注释里被大量提及
   * （解释「为什么读同一张表」），带注释匹配会一直假失败。
   */
  const stripComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  it("三处都不直接读 APP_SHORTCUTS（读默认表 = 用户改了不生效）", () => {
    const sources: Record<string, string> = {
      AppHeader: appHeaderSource,
      AppRail: appRailSource,
      terminalContextMenu: contextMenuSource
    };
    for (const [name, raw] of Object.entries(
      sources
    )) {
      const code = stripComments(raw);
      expect(
        code,
        `${name} 直接读了 APP_SHORTCUTS，应改用 ` +
          "effectiveShortcuts / shortcutOf / useShortcuts"
      ).not.toMatch(
        /[^_A-Z]APP_SHORTCUTS[^_A-Z]/
      );
    }
  });

  it("AppHeader 的按键循环依赖生效表（不改键位就触发不了）", () => {
    // 依赖数组里没有 shortcuts 的话，用户改完键位还是要按旧键才触发
    const code = stripComments(appHeaderSource);
    expect(code).toContain("useShortcuts()");
    // useEffect(..., [shortcuts])
    expect(code).toMatch(/\}, \[shortcuts\]\);/);
  });

  it("右键菜单每次弹出都刷新键位文字（DOM 只构建一次）", () => {
    const code = stripComments(contextMenuSource);
    expect(code).toContain("refreshShortcuts");
    // 顺序必须是先 ensure() 再刷新
    expect(code).toMatch(
      /const element = ensure\(\);[\s\S]{0,200}refreshShortcuts\(\)/
    );
  });

  it("右键菜单从生效表取键位，不是硬编码", () => {
    expect(contextMenuSource).toContain(
      "shortcutOf("
    );
  });

  it("useTerminals 里 find / devtools 也读生效表（不能回到硬编码）", () => {
    const code = stripComments(
      useTerminalsSource
    );
    // 有统一的匹配入口
    expect(code).toContain(
      "function matchTerminalShortcut("
    );
    // 查找与开发者工具都走它 —— 改键位才生效
    expect(code).toMatch(
      /matchTerminalShortcut\(\s*event,\s*"find"\s*\)/
    );
    expect(code).toMatch(
      /matchTerminalShortcut\(\s*event,\s*"devtools"\s*\)/
    );
    // ⚠️ 不能有硬编码的 Ctrl+F / F12 判定：
    // 那正是这次修掉的原问题（菜单显示新键位、按新键没反应）
    expect(code).not.toMatch(/key === "f"/);
    expect(code).not.toMatch(
      /event\.key === "F12"/
    );
    // 读取的是生效表
    expect(code).toContain(
      "effectiveShortcuts()"
    );
  });

  it("devtools 的历史别名仍被认（Ctrl+Shift+I）", () => {
    expect(
      stripComments(useTerminalsSource)
    ).toContain("DEVTOOLS_ALT_CHORD");
  });
});

describe("handledElsewhere", () => {
  it("find / devtools 由 useTerminals 实现，AppHeader 要跳过", () => {
    expect(handledElsewhere("find")).toBe(true);
    expect(handledElsewhere("devtools")).toBe(
      true
    );
    expect(handledElsewhere("newSession")).toBe(
      false
    );
  });
});
