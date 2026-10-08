// SFTP 双栏拖拽传输：落点判定 + 配套样式。
//
// 为什么单独测：拖拽的表现问题（拖不动、拖到哪都不生效、方向搞反）
// 在真机上手工验证成本极高，而本项目已经踩过一次 —— HTML5 原生拖放在
// WebView2 里整段静默失效。所以把「落点怎么算」「为什么必须用 pointer」
// 「样式有没有踩坑」全部拆成能跑的断言。
import { describe, expect, it } from "vitest";
import {
  resolveDropTarget,
  type DropProbe
} from "@/sftp/lib/dragTransfer";
import type { PaneEntry } from "@/sftp/lib/useSftp";

function entry(
  name: string,
  isDir: boolean
): PaneEntry {
  return {
    name,
    path: isDir
      ? `/remote/${name}`
      : `/remote/${name}.txt`,
    isDir,
    size: isDir ? 0 : 1024
  };
}

function probe(
  patch: Partial<DropProbe>
): DropProbe {
  return {
    from: "local",
    pane: "remote",
    entry: null,
    panePath: "/remote",
    ...patch
  };
}

describe("SFTP 拖拽落点判定", () => {
  it("同栏拖拽不接受 —— 栏内挪动不是传输", () => {
    expect(
      resolveDropTarget(
        probe({
          from: "local",
          pane: "local"
        })
      )
    ).toBeNull();
    expect(
      resolveDropTarget(
        probe({
          from: "remote",
          pane: "remote"
        })
      )
    ).toBeNull();
  });

  it("落到目标栏空白处 → 该栏当前目录", () => {
    const target = resolveDropTarget(probe({}));
    expect(target).not.toBeNull();
    expect(target?.intoDirectory).toBe("/remote");
    // 命中空白没有条目
    expect(target?.entryPath).toBeNull();
  });

  it("落到目录条目上 → 落进那个目录（最常用：拖进文件夹）", () => {
    const folder = entry("logs", true);
    const target = resolveDropTarget(
      probe({ entry: folder })
    );
    expect(target?.intoDirectory).toBe(
      "/remote/logs"
    );
    expect(target?.entryPath).toBe(
      "/remote/logs"
    );
  });

  it("落到文件条目上 → 落到所在栏当前目录，不进它的父目录", () => {
    // 拖到文件上若落进父目录，用户会以为「文件被替换了」
    const file = entry("a", false);
    const target = resolveDropTarget(
      probe({ entry: file })
    );
    expect(target?.intoDirectory).toBe("/remote");
    // 但仍要记住命中了谁（UI 要高亮那一行）
    expect(target?.entryPath).toBe(
      "/remote/a.txt"
    );
  });

  it("落到嵌套目录 → 落进那个嵌套目录本身", () => {
    const deep = {
      name: "logs",
      path: "/remote/var/logs",
      isDir: true,
      size: 0
    };
    expect(
      resolveDropTarget(probe({ entry: deep }))
        ?.intoDirectory
    ).toBe("/remote/var/logs");
  });

  it("目标栏还没加载出目录时拒绝落点（路径为空）", () => {
    // 空目录路径拼出来的目标是坏的，宁可不高亮
    expect(
      resolveDropTarget(probe({ panePath: "" }))
    ).toBeNull();
  });

  it("同栏一律拒绝 —— 这条不变量顺带挡掉「拖进自己/子目录」的死循环", () => {
    // 后端的上传没有"源与目标重叠"的检测，目录套自己会无限递归。
    // 唯一的防线就是前端根本不产生这种落点：
    // 无论从 local 还是 remote 起手，落在**同一栏**都被拒。
    expect(
      resolveDropTarget(
        probe({
          from: "local",
          pane: "local",
          entry: entry("logs", true)
        })
      )
    ).toBeNull();
    expect(
      resolveDropTarget(
        probe({
          from: "remote",
          pane: "remote",
          entry: entry("logs", true)
        })
      )
    ).toBeNull();
  });

  it("落点目录与来源同路径也不该出现（跨栏才可能）", () => {
    // 显式确认：只有栏不同时才可能产出落点，
    // 所以 from/pane 相同的组合（含路径相同的目录）走不到产出分支
    const folder = entry("logs", true);
    const same = resolveDropTarget(
      probe({
        from: "local",
        pane: "local",
        entry: folder,
        panePath: folder.path
      })
    );
    expect(same).toBeNull();
  });

  it("远程 → 本地方向同样成立（下载）", () => {
    const target = resolveDropTarget(
      probe({
        from: "remote",
        pane: "local",
        panePath: "C:\\Users\\me"
      })
    );
    expect(target?.pane).toBe("local");
    expect(target?.intoDirectory).toBe(
      "C:\\Users\\me"
    );
  });

  it("Windows 本地目录名里的反斜杠不被当成分隔符", () => {
    // joinPath 靠目录里有没有 `\` 判断分隔符，
    // 落点路径原样传下去即可，别在这里做规范化。
    // ⚠️ 来源栏必须是 remote —— 默认是 local，写成 pane:"local"
    // 就成了同栏拖拽，会被正确拒掉（这个坑我自己踩了一次）。
    expect(
      resolveDropTarget(
        probe({
          from: "remote",
          pane: "local",
          panePath: "D:\\work\\dist"
        })
      )?.intoDirectory
    ).toBe("D:\\work\\dist");
  });
});

describe("SFTP 拖拽样式", () => {
  /**
   * 断言某个 CSS 声明存在，**忽略冒号后的空格**。
   * `sass.compile()` 输出展开格式（`width: 10px`），vite 产物才是压缩的
   * （`width:10px`）。写死无空格在编译结果上必然失败 —— 踩过一次。
   */
  function expectDecl(
    css: string,
    prop: string,
    value: string
  ) {
    const escaped = value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    expect(css).toMatch(
      new RegExp(`${prop}:\\s*${escaped}`)
    );
  }

  async function compileApp(): Promise<string> {
    const sass = (await import("sass")).default;
    return sass
      .compile("src/styles/app.scss")
      .css.toString();
  }

  it("跟手浮标必须 pointer-events: none，否则 elementFromPoint 命中它自己", async () => {
    const block =
      (await compileApp()).match(
        /\.sftp-drag-ghost\s*\{[^}]*\}/
      )?.[0] ?? "";
    expect(block).not.toBe("");
    expectDecl(block, "pointer-events", "none");
  });

  it("跟手浮标要 fixed 定位 + 足够高的 z-index，否则会被列表盖住", async () => {
    const block =
      (await compileApp()).match(
        /\.sftp-drag-ghost\s*\{[^}]*\}/
      )?.[0] ?? "";
    expectDecl(block, "position", "fixed");
    expectDecl(block, "z-index", "999");
  });

  it("可拖的行禁掉触摸默认手势，否则触屏上变成滚页面", async () => {
    const css = await compileApp();
    const block =
      css.match(
        /\.file-row\[data-entry-path\]\s*\{[^}]*\}/
      )?.[0] ?? "";
    expect(block).not.toBe("");
    expectDecl(block, "touch-action", "none");
  });

  it("被拖走的行压暗、落点行虚线框、落点整栏描边 —— 三个状态属性都有", async () => {
    const css = await compileApp();
    expect(
      css,
      "缺 data-dragging 规则"
    ).toContain(".file-row[data-dragging]");
    expect(
      css,
      "缺 data-drop-target 规则"
    ).toContain(".file-row[data-drop-target]");
    expect(
      css,
      "缺 data-pane-target 规则"
    ).toContain(".sftp-pane[data-pane-target]");
  });

  it("落点用 outline 而不是加 border：加边框会让行变高、整列跟着抖", async () => {
    const block =
      (await compileApp()).match(
        /\.file-row\[data-drop-target\]\s*\{[^}]*\}/
      )?.[0] ?? "";
    expect(block).not.toBe("");
    // outline 画在盒外（offset 内收），不参与布局
    expectDecl(
      block,
      "outline",
      "1px dashed var(--accent)"
    );
    expectDecl(block, "outline-offset", "-1px");
    expect(block).not.toContain("border:");
  });

  it("拖拽中全局抓取光标 +禁选文本", async () => {
    const css = await compileApp();
    const block =
      css.match(
        /body\.sftp-dragging\s*\{[^}]*\}/
      )?.[0] ?? "";
    expect(block).not.toBe("");
    expectDecl(block, "cursor", "grabbing");
  });
});
