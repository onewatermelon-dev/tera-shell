import { describe, it, expect } from "vitest";
import {
  isAbsoluteRemotePath,
  parseFileToolArguments
} from "@/terminal/lib/ai/tools";
import {
  TOOL_DOWNLOAD_FILE,
  TOOL_RUN_COMMAND,
  TOOL_UPLOAD_FILE
} from "@/terminal/lib/ai/adapters";
import { SYSTEM_PROMPT } from "@/terminal/lib/ai/promptContext";

/**
 * AI 助手的文件上传 / 下载。
 *
 * ## 为什么工具名要分派
 *
 * 原先 `runLoop` 里 `for (const call of calls)` 一律走
 * `parseToolArguments`，它只认 `command` 字段。传进来一个
 * `upload_local_file` 的参数（只有 remote_path），解出来是 null ——
 * 模型看到的是「参数解析失败，请重试」，永远传不了文件。
 *
 * ## 为什么本地路径不能由模型给
 *
 * 工具 schema 里**只有 remote_path**。本地文件由用户在系统「打开文件」
 * 框里亲自挑 —— 否则等于给模型开了任意本地文件读取的口子
 * （`C:\Users\x\.ssh\id_rsa`、`C:\Windows\System32\config\SAM` 都能要到）。
 */
describe("AI 文件上传 / 下载", () => {
  it("两个传输工具名固定（分派靠它，改名要同步三处注入）", () => {
    expect(TOOL_UPLOAD_FILE).toBe(
      "upload_local_file"
    );
    expect(TOOL_DOWNLOAD_FILE).toBe(
      "download_remote_file"
    );
    expect(TOOL_RUN_COMMAND).toBe("run_command");
  });

  it("三种协议格式都注入三个工具", async () => {
    const src = (
      await import("@/terminal/lib/ai/adapters?raw")
    ).default;
    // openAi / anthropic / responses 各一处，三处都要齐 —— 漏一处
    // 就只在那家供应商的模型上表现为「AI 说要传文件但传不了」。
    // 断的是常量名不是字面量：字面量只在常量定义处出现一次
    for (const constant of [
      "TOOL_UPLOAD_FILE",
      "TOOL_DOWNLOAD_FILE",
      "TOOL_RUN_COMMAND"
    ]) {
      const hits =
        src.match(
          new RegExp(`name: ${constant}\\b`, "g")
        ) ?? [];
      expect(
        hits.length,
        `${constant} 只注入了 ${hits.length} 处，应为 3 处`
      ).toBe(3);
    }
  });

  it("传输工具的 schema 里没有本地路径参数", async () => {
    const src = (
      await import("@/terminal/lib/ai/adapters?raw")
    ).default;
    const start = src.indexOf(
      "const UPLOAD_FILE_PARAMETERS"
    );
    const block = src.slice(start, start + 900);
    expect(block).toContain("remote_path");
    // ⚠️ 出现 local_path 就是在给模型开任意文件读取的口子
    expect(block).not.toContain("local_path");
    expect(block).not.toContain("localPath");
  });

  it("解析传输工具参数：给绝对路径就通过", () => {
    expect(
      parseFileToolArguments(
        '{"remote_path":"/tmp/a.tar.gz","question":"部署包"}'
      )
    ).toEqual({
      remotePath: "/tmp/a.tar.gz",
      question: "部署包"
    });
    // question 缺失也要能过 —— 卡片只是少一行解释
    expect(
      parseFileToolArguments(
        '{"remote_path":"/etc/hosts"}'
      )
    ).toEqual({
      remotePath: "/etc/hosts",
      question: ""
    });
  });

  it("相对路径与波浪号路径一律拒绝", () => {
    // 相对路径会传到模型意想不到的地方；`~root/.ssh/id_rsa` 是 ssh 的
    // 波浪号展开语法，很多远程 shell 根本不认，会当字面目录名传过去
    for (const bad of [
      "../../etc/passwd",
      "~/secret.txt",
      "~root/.ssh/id_rsa",
      "  ",
      ""
    ]) {
      expect(
        parseFileToolArguments(
          JSON.stringify({
            remote_path: bad
          })
        ),
        `${bad} 不该被接受`
      ).toBeNull();
    }
  });

  it("绝对路径判定：Linux、Windows 盘符、UNC 都算", () => {
    expect(
      isAbsoluteRemotePath("/etc/hosts")
    ).toBe(true);
    expect(
      isAbsoluteRemotePath("C:\\temp\\a")
    ).toBe(true);
    expect(
      isAbsoluteRemotePath("D:/data/a")
    ).toBe(true);
    expect(
      isAbsoluteRemotePath("\\\\srv\\share\\a")
    ).toBe(true);
    expect(isAbsoluteRemotePath("a/b")).toBe(
      false
    );
    expect(isAbsoluteRemotePath("./a")).toBe(
      false
    );
    // C: 后面没有分隔符是盘符相对路径，不算绝对
    expect(isAbsoluteRemotePath("C:a")).toBe(
      false
    );
  });

  it("非法 JSON / 缺 remote_path 返回 null", () => {
    expect(
      parseFileToolArguments("不是 json")
    ).toBeNull();
    expect(
      parseFileToolArguments('{"question":"x"}')
    ).toBeNull();
    expect(
      parseFileToolArguments(
        '{"remote_path":123}'
      )
    ).toBeNull();
  });

  it("runLoop 先按工具名分派，再走各自的参数解析", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    // ⚠️ 顺序反了会拿 parseToolArguments 去解传输参数 → 恒为 null
    const fileBranch = src.indexOf(
      "TOOL_UPLOAD_FILE"
    );
    const runArgs = src.indexOf(
      "parseToolArguments("
    );
    expect(fileBranch).toBeGreaterThan(-1);
    expect(runArgs).toBeGreaterThan(-1);
    expect(fileBranch).toBeLessThan(runArgs);
    expect(src).toContain(
      "parseFileToolArguments("
    );
  });

  it("挂起表用判别联合存两类卡片", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    // 两个 Map 会让 confirm/skip 得「先查命令表、没有再查传输表」，
    // 漏一处就是点按钮没反应
    expect(src).toContain('kind: "file"');
    expect(src).toContain('kind: "tool"');
    expect(src).toContain("held.kind ===");
  });

  it("传输卡片一律等确认，不参与自动执行 / 自动应用", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    // ⚠️ 用 lastIndexOf：`TOOL_UPLOAD_FILE` 在文件头的 import 里
    // 也出现过一次，从头切会连 import 段一起切进来（里面也有
    // autoExecute 字样，是另一处代码的）。
    const branch = src.slice(
      src.lastIndexOf("TOOL_UPLOAD_FILE"),
      src.indexOf(
        "const parsed = parseToolArguments("
      )
    );
    expect(branch).toContain(
      "pendingRef.current.set"
    );
    expect(branch).toContain("yielded = true");
    // 分支里绝不能碰自动执行开关：传输要读写用户本地磁盘
    expect(branch).not.toContain("autoExecute");
    expect(branch).not.toContain("autoApply");
    expect(branch).not.toContain("isBlacklisted");
  });

  it("传输必须走 SFTP，不能用 run_command 拼 base64", async () => {
    const src = (
      await import("@/terminal/lib/ai/fileTransfer.ts?raw")
    ).default;
    expect(src).toContain("sftp_upload");
    expect(src).toContain("sftp_download");
    // 系统弹窗：本地文件必须用户亲自挑
    expect(src).toContain("fs_pick_file");
    expect(src).toContain("fs_pick_save_path");
  });

  it("传输前必须解密密码（session.password 是 DPAPI 密文）", async () => {
    const src = (
      await import("@/terminal/lib/ai/fileTransfer.ts?raw")
    ).default;
    // 直接透传密文会认证失败 —— cardExec 里还留着这个坑，
    // 传输这里不能跟着抄
    expect(src).toContain("resolvePassword");
  });

  it("系统提示词说明了两个传输工具与绝对路径约束", () => {
    expect(SYSTEM_PROMPT).toContain(
      TOOL_UPLOAD_FILE
    );
    expect(SYSTEM_PROMPT).toContain(
      TOOL_DOWNLOAD_FILE
    );
    expect(SYSTEM_PROMPT).toContain("绝对路径");
    // 提示模型别用 run_command 绕（base64 有长度上限、cat 只能写文本）
    expect(SYSTEM_PROMPT).toContain("base64");
  });

  it("历史恢复时不给卡片硬塞 sentAt", async () => {
    const src = (
      await import("@/terminal/lib/ai/useAiHistory.ts?raw")
    ).default;
    // 卡片的 React key 用的是 call.id，塞 sentAt 反而会引入
    // 无意义的字段；原来写的是 `kind !== "tool"`，新增 kind:"file"
    // 后必须显式列两种，否则文件卡片会被塞上 sentAt
    expect(src).toContain(
      'entry.kind === "user"'
    );
    expect(src).toContain(
      'entry.kind === "assistant"'
    );
    expect(src).not.toContain(
      'entry.kind !== "tool"'
    );
  });

  it("两个后端命令已注册", async () => {
    const src = (
      await import("../src-tauri/src/lib.rs?raw")
    ).default;
    // 漏注册的表现是前端 invoke 报 "command not found"，
    // 且只在真正点传输时才炸 —— 静态钉住更省事
    expect(src).toContain("fs::pick_file");
    expect(src).toContain("fs::pick_save_path");
  });
});
