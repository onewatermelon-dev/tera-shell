import { describe, it, expect } from "vitest";
import {
  buildRunbook,
  extractRunbookMaterial,
  redactSecrets,
  runbookFileName
} from "@/terminal/lib/ai/runbook";
import type { AiChatEntry } from "@/terminal/lib/ai/protocol";

/** 造一条只读命令卡。 */
function tool(
  command: string,
  options: {
    readOnly?: boolean;
    note?: string;
    failed?: boolean;
  } = {}
): AiChatEntry {
  return {
    kind: "tool",
    call: {
      id: `call_${command}`,
      command,
      question: options.note ?? "",
      isReadOnly: options.readOnly ?? true,
      state: options.failed ? "failed" : "done",
      exitCode: options.failed ? 1 : 0
    }
  };
}

const conversation: AiChatEntry[] = [
  { kind: "user", text: "磁盘满了，帮我看看" },
  { kind: "assistant", text: "先确认占用情况。" },
  tool("df -h /var", { note: "看分区占用" }),
  tool("du -sh /var/* | sort -rh | head", {
    note: "找大户"
  }),
  { kind: "assistant", text: "是日志占满的。" },
  tool(
    "find /var/log -name '*.gz' -mtime +30 -delete",
    {
      readOnly: false,
      note: "清理旧归档日志"
    }
  ),
  tool("df -h /var", { note: "复查" }),
  {
    kind: "assistant",
    text: "/var 已降到 62%。建议后续加日志轮转。"
  }
];

describe("素材提取", () => {
  it("只读命令进前置检查、读写命令进步骤，保持原顺序", () => {
    const material =
      extractRunbookMaterial(conversation);
    expect(material.scene).toBe(
      "磁盘满了，帮我看看"
    );
    expect(
      material.checks.map(item => item.command)
    ).toEqual([
      "df -h /var",
      "du -sh /var/* | sort -rh | head",
      "df -h /var"
    ]);
    expect(
      material.steps.map(item => item.command)
    ).toEqual([
      "find /var/log -name '*.gz' -mtime +30 -delete"
    ]);
    // 结论取最后一条助手回复
    expect(material.conclusion).toContain(
      "已降到 62%"
    );
  });

  it("首条用户消息就是场景，后续追问不进 runbook", () => {
    const material = extractRunbookMaterial([
      { kind: "user", text: "第一条" },
      { kind: "user", text: "第二条追问" }
    ]);
    expect(material.scene).toBe("第一条");
  });

  it("失败命令被标记", () => {
    const material = extractRunbookMaterial([
      tool("systemctl restart nginx", {
        readOnly: false,
        failed: true
      })
    ]);
    expect(material.steps[0]?.failed).toBe(true);
  });

  it("文件改动 / 传输进「附带影响」", () => {
    const material = extractRunbookMaterial([
      {
        kind: "edit",
        call: {
          id: "call_edit",
          path: "/etc/nginx/nginx.conf",
          summary: "调大 keepalive",
          edits: [
            { old_string: "a", new_string: "b" }
          ],
          state: "applied"
        }
      },
      {
        kind: "file",
        call: {
          id: "call_file",
          direction: "download",
          remotePath: "/var/log/app.log",
          question: "下载日志",
          state: "done"
        }
      }
    ]);
    expect(material.sideEffects).toHaveLength(2);
    expect(material.sideEffects[0]).toContain(
      "/etc/nginx/nginx.conf"
    );
    expect(material.sideEffects[0]).toContain(
      "已应用"
    );
    expect(material.sideEffects[1]).toContain(
      "下载"
    );
  });

  it("模型嘴上提到但没执行的命令不算", () => {
    const material = extractRunbookMaterial([
      {
        kind: "assistant",
        text: "你可以跑 df -h 看看"
      }
    ]);
    expect(material.checks).toHaveLength(0);
    expect(material.steps).toHaveLength(0);
  });
});

describe("脱敏", () => {
  it("password / token / secret 的键值对替换", () => {
    expect(
      redactSecrets(
        "mysql -u root --password=abc123"
      )
    ).toBe("mysql -u root --password=***");
    expect(
      redactSecrets("export TOKEN=ghp_abcdef123")
    ).toBe("export TOKEN=***");
    expect(
      redactSecrets(
        "curl -H 'Authorization: Bearer eyJhbGciOi'"
      )
    ).toContain("Bearer ***");
    expect(
      redactSecrets("mysql -uroot -pMyPass123 db")
    ).toBe("mysql -uroot -p*** db");
  });

  it("正常命令不被误伤", () => {
    expect(redactSecrets("df -h /var")).toBe(
      "df -h /var"
    );
    expect(
      redactSecrets(
        "tail -n 100 /var/log/app.log"
      )
    ).toBe("tail -n 100 /var/log/app.log");
  });
});

describe("Runbook 正文", () => {
  const markdown = buildRunbook(conversation, {
    host: "root@10.0.0.5",
    createdAt: Date.UTC(2026, 9, 18, 2)
  });

  it("章节齐全", () => {
    for (const heading of [
      "# Runbook：",
      "## 触发场景",
      "## 前置检查",
      "## 命令步骤",
      "## 结论",
      "## 风险与回滚"
    ])
      expect(markdown).toContain(heading);
  });

  it("命令进代码块且带编号", () => {
    expect(markdown).toContain("```bash");
    expect(markdown).toContain("df -h /var");
    expect(markdown).toContain(
      "find /var/log -name '*.gz' -mtime +30 -delete"
    );
    // 步骤从 1 开始编号
    expect(markdown).toMatch(/\n1\. /);
  });

  it("头部写明主机与脱敏提示", () => {
    expect(markdown).toContain("root@10.0.0.5");
    expect(markdown).toContain("脱敏");
  });

  it("脱敏结果进了正文（命令里的密码不外泄）", () => {
    const withSecret = buildRunbook(
      [
        { kind: "user", text: "改密码" },
        tool(
          "mysql -u root --password=Hunter2! -e 'x'",
          {
            readOnly: false
          }
        )
      ],
      { createdAt: Date.now() }
    );
    expect(withSecret).not.toContain("Hunter2!");
    expect(withSecret).toContain(
      "--password=***"
    );
  });

  it("没有命令/结论时给占位而不是空白", () => {
    const empty = buildRunbook(
      [{ kind: "user", text: "随便聊聊" }],
      { createdAt: Date.now() }
    );
    expect(empty).toContain(
      "（本次会话没有只读排查命令）"
    );
    expect(empty).toContain(
      "（本次会话没有变更类命令）"
    );
    expect(empty).toContain(
      "（本次会话没有助手结论）"
    );
  });

  it("失败命令在风险区提示数量", () => {
    const withFailure = buildRunbook(
      [
        { kind: "user", text: "重启服务" },
        tool("systemctl restart nginx", {
          readOnly: false,
          failed: true
        })
      ],
      { createdAt: Date.now() }
    );
    expect(withFailure).toContain(
      "有 1 条命令执行失败"
    );
    expect(withFailure).toContain("（执行失败）");
  });
});

describe("文件名", () => {
  it("主机 + 场景 + 日期，去掉非法字符", () => {
    const name = runbookFileName(
      conversation,
      "root@10.0.0.5",
      Date.UTC(2026, 9, 18, 2)
    );
    expect(name).toBe(
      "root@10.0.0.5-磁盘满了-帮我看看-20261018.md"
    );
    // 不含路径分隔符等非法字符（@ 允许，- 允许）
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("没有主机/场景也能给个兜底名", () => {
    const name = runbookFileName(
      [],
      undefined,
      Date.UTC(2026, 9, 18, 2)
    );
    expect(name).toBe("runbook-20261018.md");
  });
});

describe("入口接线", () => {
  it("历史菜单有导出项，面板负责生成与保存", async () => {
    const menu = (
      await import("@/terminal/components/ai/AiHistoryMenu.tsx?raw")
    ).default;
    expect(menu).toContain("onExportRunbook");
    // 「总导出」入口已删除（用户要求）
    expect(menu).not.toContain(
      "onExportCurrentRunbook"
    );
    // 行内按钮把这条历史传出去（每条历史单独导出）
    expect(menu).toContain(
      "onExportRunbook(history)"
    );

    const panel = (
      await import("@/terminal/components/ai/AiPanel.tsx?raw")
    ).default;
    expect(panel).toContain("buildRunbook");
    expect(panel).toContain("runbookFileName");
    // 走系统保存框，不自己挑路径
    expect(panel).toContain("fs_save_text_file");
    // ⚠️ 关键：历史里自带 entries 快照，导出不必先恢复会话
    expect(panel).toContain("history.entries");
    expect(panel).toContain("history.host");
  });
});
