import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// i18n 用 useSyncExternalStore，SSR 下缺 getServerSnapshot 会抛
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));
import {
  applyEdits,
  buildHunks,
  computeLineDiff,
  diffLanguageFor,
  FILE_DIFF_LIMIT
} from "@/terminal/lib/ai/fileDiff";
import { parseEditToolArguments } from "@/terminal/lib/ai/tools";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";

describe("查找/替换应用", () => {
  const base = `server {
  listen 80;
  keepalive_timeout 65;
  server_name example.com;
}`;

  it("正常替换：改中间一行", () => {
    const result = applyEdits(base, [
      {
        oldString: "keepalive_timeout 65;",
        newString: "keepalive_timeout 75;"
      }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toContain(
      "keepalive_timeout 75;"
    );
    expect(result.newContent).not.toContain(
      "keepalive_timeout 65;"
    );
    // 其余内容原样
    expect(result.newContent).toContain(
      "server_name example.com;"
    );
  });

  it("多处替换按顺序叠加", () => {
    const result = applyEdits(base, [
      {
        oldString: "listen 80;",
        newString: "listen 8080;"
      },
      {
        oldString: "keepalive_timeout 65;",
        newString: "keepalive_timeout 75;"
      }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toContain(
      "listen 8080;"
    );
    expect(result.newContent).toContain(
      "keepalive_timeout 75;"
    );
  });

  it("原文不存在 → 失败（模型看到的版本已过期或在编造）", () => {
    const result = applyEdits(base, [
      {
        oldString: "keepalive_timeout 999;",
        newString: "x"
      }
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("找不到");
  });

  it("原文出现多次 → 失败（不猜、不取第一个）", () => {
    const result = applyEdits("a\nX\nb\nX\nc", [
      { oldString: "X", newString: "Y" }
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("多次");
  });

  it("纯新增（old_string 是插入点锚点）也走唯一匹配", () => {
    const result = applyEdits(base, [
      {
        oldString: "  listen 80;",
        newString:
          "  listen 80;\n  access_log /var/log/nginx/access.log;"
      }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toContain(
      "access_log /var/log/nginx/access.log;"
    );
  });
});

describe("行级 diff", () => {
  it("单行改动：一条删一条增 + 上下文", () => {
    const diff = computeLineDiff(
      "a\nb\nc",
      "a\nB\nc"
    );
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(
      diff.lines.map(line => line.kind)
    ).toEqual([
      "context",
      "remove",
      "add",
      "context"
    ]);
    // 行号：删的是旧 2，增的是新 2
    const remove = diff.lines.find(
      line => line.kind === "remove"
    );
    const add = diff.lines.find(
      line => line.kind === "add"
    );
    expect(remove?.oldLine).toBe(2);
    expect(remove?.newLine).toBeUndefined();
    expect(add?.newLine).toBe(2);
    expect(add?.oldLine).toBeUndefined();
  });

  it("纯新增行：只有 add，旧行号为空", () => {
    const diff = computeLineDiff(
      "a\nc",
      "a\nb\nc"
    );
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  it("纯删除：只有 remove", () => {
    const diff = computeLineDiff(
      "a\nb\nc",
      "a\nc"
    );
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(1);
  });

  it("完全相同 → 无变更行", () => {
    const diff = computeLineDiff("a\nb", "a\nb");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(
      diff.lines.every(
        line => line.kind === "context"
      )
    ).toBe(true);
  });

  it("整文件替换：统计正确", () => {
    const diff = computeLineDiff(
      "a\nb",
      "x\ny\nz"
    );
    expect(diff.added).toBe(3);
    expect(diff.removed).toBe(2);
  });

  it("空文件 → 有内容：全是 add", () => {
    const diff = computeLineDiff("", "x\ny");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
  });
});

describe("hunk 切分", () => {
  it("单处改动：一个 hunk，带 3 行上下文", () => {
    const old = Array.from(
      { length: 10 },
      (_, i) => `line ${i}`
    );
    const changed = [...old];
    changed[5] = "line 5 changed";
    const diff = computeLineDiff(
      old.join("\n"),
      changed.join("\n")
    );
    const hunks = buildHunks(diff.lines);
    expect(hunks).toHaveLength(1);
    // 上下文 = 第 3~9 行（6±3），改动行一删一增算两行 → 8 行
    expect(hunks[0]?.lines).toHaveLength(8);
    expect(hunks[0]?.oldStart).toBe(3);
  });

  it("相距远的两处改动：两个 hunk", () => {
    const old = Array.from(
      { length: 30 },
      (_, i) => `line ${i}`
    );
    const changed = [...old];
    changed[2] = "changed 2";
    changed[25] = "changed 25";
    const diff = computeLineDiff(
      old.join("\n"),
      changed.join("\n")
    );
    const hunks = buildHunks(diff.lines);
    expect(hunks).toHaveLength(2);
  });

  it("相距近的两处改动：合并成一个 hunk（git 行为）", () => {
    const old = Array.from(
      { length: 20 },
      (_, i) => `line ${i}`
    );
    const changed = [...old];
    changed[5] = "changed 5";
    changed[9] = "changed 9";
    const diff = computeLineDiff(
      old.join("\n"),
      changed.join("\n")
    );
    const hunks = buildHunks(diff.lines);
    expect(hunks).toHaveLength(1);
  });

  it("无变更 → 没有 hunk", () => {
    const diff = computeLineDiff("a", "a");
    expect(buildHunks(diff.lines)).toEqual([]);
  });
});

describe("edit_remote_file 参数解析", () => {
  it("完整参数：绝对路径 + 说明 + 替换块", () => {
    const parsed = parseEditToolArguments(
      JSON.stringify({
        path: "/etc/nginx/nginx.conf",
        summary: "调大 keepalive",
        edits: [
          {
            old_string: "keepalive_timeout 65;",
            new_string: "keepalive_timeout 75;"
          }
        ]
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.path).toBe(
      "/etc/nginx/nginx.conf"
    );
    expect(parsed?.edits[0]?.oldString).toBe(
      "keepalive_timeout 65;"
    );
  });

  it("相对路径 / 空路径 → null", () => {
    const base = {
      summary: "s",
      edits: [
        { old_string: "a", new_string: "b" }
      ]
    };
    expect(
      parseEditToolArguments(
        JSON.stringify({
          ...base,
          path: "etc/nginx.conf"
        })
      )
    ).toBeNull();
    expect(
      parseEditToolArguments(
        JSON.stringify({ ...base, path: "  " })
      )
    ).toBeNull();
  });

  it("空 old_string → null（会匹配到任意位置，必须挡）", () => {
    expect(
      parseEditToolArguments(
        JSON.stringify({
          path: "/etc/hosts",
          summary: "s",
          edits: [
            { old_string: "", new_string: "x" }
          ]
        })
      )
    ).toBeNull();
  });

  it("空 new_string / edits 空 / 非数组 → null", () => {
    expect(
      parseEditToolArguments(
        JSON.stringify({
          path: "/etc/hosts",
          summary: "s",
          edits: [
            { old_string: "a", new_string: "" }
          ]
        })
      )
    ).toBeNull();
    expect(
      parseEditToolArguments(
        JSON.stringify({
          path: "/etc/hosts",
          summary: "s",
          edits: []
        })
      )
    ).toBeNull();
    expect(
      parseEditToolArguments(
        JSON.stringify({
          path: "/etc/hosts",
          summary: "s",
          edits: "nope"
        })
      )
    ).toBeNull();
  });

  it("替换块超上限按上限截断（不整份作废）", () => {
    const edits = Array.from(
      { length: 25 },
      (_, i) => ({
        old_string: `old ${i}`,
        new_string: `new ${i}`
      })
    );
    const parsed = parseEditToolArguments(
      JSON.stringify({
        path: "/etc/hosts",
        summary: "s",
        edits
      })
    );
    expect(parsed?.edits).toHaveLength(20);
  });

  it("工具名泄漏时替换为「修改文件」", () => {
    expect(
      sanitizeToolNames("用 edit_remote_file 改")
    ).toContain("修改文件");
  });
});

describe("文件路径 → 高亮语言", () => {
  it("常见配置与脚本扩展名", () => {
    expect(
      diffLanguageFor("/etc/nginx/nginx.conf")
    ).toBe("ini");
    expect(
      diffLanguageFor("/srv/app/config.yaml")
    ).toBe("yaml");
    expect(
      diffLanguageFor("/srv/app/config.yml")
    ).toBe("yaml");
    expect(
      diffLanguageFor("/srv/app/package.json")
    ).toBe("json");
    expect(
      diffLanguageFor("/srv/deploy.sh")
    ).toBe("bash");
    expect(diffLanguageFor("/srv/main.py")).toBe(
      "python"
    );
    expect(diffLanguageFor("/srv/index.ts")).toBe(
      "typescript"
    );
    expect(diffLanguageFor("/srv/main.rs")).toBe(
      "rust"
    );
  });

  it("无扩展名的知名配置文件", () => {
    expect(
      diffLanguageFor("/etc/ssh/sshd_config")
    ).toBe("ini");
    expect(diffLanguageFor("/etc/hosts")).toBe(
      "ini"
    );
    expect(diffLanguageFor("/etc/fstab")).toBe(
      "ini"
    );
    expect(
      diffLanguageFor("/srv/Dockerfile")
    ).toBe("dockerfile");
    expect(diffLanguageFor("/srv/Makefile")).toBe(
      "makefile"
    );
    expect(diffLanguageFor("/root/.bashrc")).toBe(
      "bash"
    );
  });

  it("认不出的一律 plaintext（不猜错语言染错色）", () => {
    expect(
      diffLanguageFor("/var/log/syslog")
    ).toBe("plaintext");
    expect(
      diffLanguageFor("/etc/unknown.xyz")
    ).toBe("plaintext");
    expect(diffLanguageFor("")).toBe("plaintext");
  });

  it("大小写不敏感", () => {
    expect(diffLanguageFor("/srv/APP.PY")).toBe(
      "python"
    );
    expect(
      diffLanguageFor("/srv/DOCKERFILE")
    ).toBe("dockerfile");
  });
});

describe("文件改动的接线（防静默失效）", () => {
  it("diff 上限是正数（防止误设 0 把所有文件都判过大）", () => {
    expect(FILE_DIFF_LIMIT).toBeGreaterThan(1024);
  });

  it("schema 三处注入 + 引擎分支 + 卡片渲染", async () => {
    const adapters = (
      await import("@/terminal/lib/ai/adapters.ts?raw")
    ).default;
    const uses =
      adapters.match(/TOOL_EDIT_FILE/g) ?? [];
    expect(uses.length).toBe(4);

    const chat = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(chat).toContain("loadFileEdit");
    expect(chat).toContain("approveFileEdit");
    expect(chat).toContain("cancelFileEdit");
    // confirm / skip 挡掉 edit 卡（有专属入口）
    expect(chat).toMatch(/held\.kind === "edit"/);

    const list = (
      await import("@/terminal/components/ai/AiMessageList.tsx?raw")
    ).default;
    expect(list).toContain("AiFileDiffCard");
    expect(list).toContain('kind === "edit"');
  });

  it("diff 内容接语法着色（固定 One Dark Pro）", async () => {
    const card = (
      await import("@/terminal/components/ai/AiFileDiffCard.tsx?raw")
    ).default;
    expect(card).toContain("createTokenSource");
    expect(card).toContain("diffLanguageFor");
    // token 只取深色值（One Dark Pro），浅色值丢弃
    expect(card).toContain(
      'token.htmlStyle?.["--shiki-dark"]'
    );
    const css = (
      await import("sass")
    ).default.compile(
      "src/terminal/components/ai/AiFileDiffCard.module.css"
    ).css;
    // 固定深色代码面板：ODP 编辑器底，不随应用主题变
    expect(css).toContain("#282c34");
    // ODP 红删绿增
    expect(css).toContain("#e06c75");
    expect(css).toContain("#98c379");
  });

  it("提示词交代了「不給整份内容、一律等批准」", async () => {
    const { SYSTEM_PROMPT } =
      await import("@/terminal/lib/ai/promptContext");
    expect(SYSTEM_PROMPT).toContain(
      "文件改动工具"
    );
    expect(SYSTEM_PROMPT).toContain("原样拷贝");
    expect(SYSTEM_PROMPT).toContain(
      "没有自动应用"
    );
  });
});

describe("diff 卡渲染（+/- 标记）", () => {
  it("增删行前面有 + 和 -，上下文行留空", async () => {
    const { AiFileDiffCard } =
      await import("@/terminal/components/ai/AiFileDiffCard");
    const html = renderToStaticMarkup(
      createElement(AiFileDiffCard, {
        call: {
          id: "call_edit_1",
          path: "/etc/nginx/nginx.conf",
          summary: "调大 keepalive",
          edits: [
            {
              old_string: "keepalive_timeout 65;",
              new_string: "keepalive_timeout 75;"
            }
          ],
          state: "ready",
          hunks: [
            {
              oldStart: 2,
              newStart: 2,
              lines: [
                {
                  kind: "context",
                  text: "  listen 80;",
                  oldLine: 2,
                  newLine: 2
                },
                {
                  kind: "remove",
                  text: "  keepalive_timeout 65;",
                  oldLine: 3
                },
                {
                  kind: "add",
                  text: "  keepalive_timeout 75;",
                  newLine: 3
                }
              ]
            }
          ],
          addedLines: 1,
          removedLines: 1
        },
        busy: false,
        onLoad: () => {},
        onApprove: () => {},
        onCancel: () => {}
      })
    );
    // 标记列：删除行是「-」、新增行是「+」（git 标准）
    expect(html).toContain(
      'data-kind="remove">-<'
    );
    expect(html).toContain('data-kind="add">+<');
    // 行内容与路径照常渲染
    expect(html).toContain(
      "keepalive_timeout 75;"
    );
    expect(html).toContain(
      "/etc/nginx/nginx.conf"
    );
    // @@ 行号头已删（每行有行号列，它是冗余信息）
    expect(html).not.toContain("@@");
    // 操作按钮在位
    expect(html).toContain("ai.edit.apply");
  });

  it("loading 态：转圈 + 无 diff 无按钮", async () => {
    const { AiFileDiffCard } =
      await import("@/terminal/components/ai/AiFileDiffCard");
    const html = renderToStaticMarkup(
      createElement(AiFileDiffCard, {
        call: {
          id: "call_edit_2",
          path: "/etc/hosts",
          summary: "",
          edits: [
            { old_string: "a", new_string: "b" }
          ],
          state: "loading"
        },
        busy: false,
        onLoad: () => {},
        onApprove: () => {},
        onCancel: () => {}
      })
    );
    expect(html).toContain("ai.edit.loading");
    expect(html).not.toContain("ai.edit.apply");
    expect(html).not.toContain("@@");
  });

  it("error 态：红字原因，不给批准按钮", async () => {
    const { AiFileDiffCard } =
      await import("@/terminal/components/ai/AiFileDiffCard");
    const html = renderToStaticMarkup(
      createElement(AiFileDiffCard, {
        call: {
          id: "call_edit_3",
          path: "/etc/hosts",
          summary: "",
          edits: [
            { old_string: "a", new_string: "b" }
          ],
          state: "error",
          error:
            "找不到要替换的内容（文件里没有这段原文）"
        },
        busy: false,
        onLoad: () => {},
        onApprove: () => {},
        onCancel: () => {}
      })
    );
    expect(html).toContain("找不到");
    expect(html).not.toContain("ai.edit.apply");
  });
});
