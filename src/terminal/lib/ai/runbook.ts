/**
 * 会话 → Runbook（Markdown）。
 *
 * ## 为什么是「从对话导出」
 *
 * 一次排查/变更的对话本身就是最好的 runbook 草稿：里面有真实执行的
 * 命令、真实报错、真实解法。但聊天记录不是文档 —— 它夹着思考过程、
 * 试错的命令、寒暄。这里做的事就是**过滤 + 归档**：
 *
 * - 只读命令 → 「前置检查」（排查动作，下次先跑这些看现场）
 * - 读写命令 → 「命令步骤」（真正的变更动作，按执行顺序编号）
 * - 最后一条助手回复 → 「结论」
 * - 其余噪音（思考过程、失败的试探、工具卡片中间的来回）不导出
 *
 * ## 脱敏
 *
 * 命令里可能带密码/令牌，导出前做基础替换（见 redactSecrets）。
 * 这是**兜底**，不是保证 —— 文档里会写一条提示让人自己复核。
 */
import type { AiChatEntry } from "./protocol";

/** 一条被提取出来的命令。 */
export type RunbookCommand = {
  command: string;
  /** 模型给的执行说明（可能为空串） */
  note: string;
  /** 执行失败的命令（rollback 里要提示） */
  failed: boolean;
};

/** 从对话里提取的结构化素材（纯函数，供测试与生成共用）。 */
export type RunbookMaterial = {
  /** 首条用户提问（触发场景） */
  scene: string;
  /** 只读命令（前置检查） */
  checks: RunbookCommand[];
  /** 读写命令（命令步骤） */
  steps: RunbookCommand[];
  /** 最后一条助手回复（结论） */
  conclusion: string;
  /** 文件改动与传输（附录） */
  sideEffects: string[];
};

/**
 * 基础脱敏：把常见的「键=值」型密钥替换成 ***。
 *
 * ⚠️ 只覆盖最常见的几种写法（password=/token:/--password xxx/Bearer）。
 * 真正的保障是导出后人工复核 —— 不要指望正则穷尽所有形式。
 */
export function redactSecrets(
  text: string
): string {
  return (
    text
      // password=xxx / passwd: xxx / token=xxx / secret= / api_key=
      .replace(
        /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth[_-]?token)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
        "$1$2***"
      )
      // --password xxx（空格分隔，mysql -p 同理）
      .replace(/(\s-p)(?!\s)\S+/g, "$1***")
      .replace(/(--password\s+)(\S+)/gi, "$1***")
      // Authorization: Bearer xxx
      .replace(
        /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g,
        "$1***"
      )
  );
}

/** 单行化：标题/说明里塞进换行会破坏 Markdown 结构。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 从对话条目里提取素材。
 *
 * 命令来源只认 `kind === "tool"`（真正执行过的），模型嘴上提到的命令
 * 不算 —— runbook 的价值在于「这些确实跑过」。
 */
export function extractRunbookMaterial(
  entries: AiChatEntry[]
): RunbookMaterial {
  let scene = "";
  let conclusion = "";
  const checks: RunbookCommand[] = [];
  const steps: RunbookCommand[] = [];
  const sideEffects: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "user") {
      // 首条用户消息作为触发场景；后续追问不进 runbook
      if (!scene) scene = oneLine(entry.text);
      continue;
    }
    if (entry.kind === "assistant") {
      if (entry.text.trim())
        conclusion = entry.text.trim();
      continue;
    }
    if (entry.kind === "tool") {
      const call = entry.call;
      if (!call.command.trim()) continue;
      const item: RunbookCommand = {
        command: redactSecrets(
          call.command
        ).trim(),
        note: oneLine(call.question ?? ""),
        failed:
          call.state === "failed" ||
          (call.exitCode != null &&
            call.exitCode !== 0)
      };
      // 只读 = 排查动作；读写 = 变更动作
      if (call.isReadOnly) checks.push(item);
      else steps.push(item);
      continue;
    }
    if (entry.kind === "edit") {
      sideEffects.push(
        `修改文件 \`${entry.call.path}\`${
          entry.call.summary
            ? `：${oneLine(entry.call.summary)}`
            : ""
        }（${
          entry.call.state === "applied"
            ? "已应用"
            : entry.call.state === "cancelled"
              ? "已取消"
              : "未应用"
        }）`
      );
      continue;
    }
    if (entry.kind === "file") {
      sideEffects.push(
        `${
          entry.call.direction === "upload"
            ? "上传"
            : "下载"
        } \`${entry.call.remotePath}\`（${
          entry.call.state === "done"
            ? "完成"
            : "未完成"
        }）`
      );
    }
  }

  return {
    scene,
    checks,
    steps,
    conclusion,
    sideEffects
  };
}

/** 渲染命令列表：编号 + 说明 + 代码块。空列表给一句占位。 */
function renderCommands(
  items: RunbookCommand[],
  emptyText: string
): string {
  if (items.length === 0) return emptyText;
  return items
    .map((item, index) => {
      const note = item.note
        ? `${item.note}${item.failed ? "（执行失败）" : ""}`
        : item.failed
          ? "（执行失败）"
          : "";
      return [
        `${index + 1}. ${note}`.trimEnd(),
        "",
        "   ```bash",
        ...item.command
          .split("\n")
          .map(line => `   ${line}`),
        "   ```"
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * 生成 Runbook 的 Markdown 正文。
 *
 * @param entries 当前对话的条目（AiChatEntry[]）
 * @param options.host 目标主机（写在头部，便于区分环境）
 * @param options.createdAt 导出时间（毫秒时间戳）
 */
export function buildRunbook(
  entries: AiChatEntry[],
  options: {
    host?: string;
    createdAt: number;
  }
): string {
  const material =
    extractRunbookMaterial(entries);
  const title =
    material.scene.slice(0, 60) || "未命名会话";
  const failed = [
    ...material.checks,
    ...material.steps
  ].filter(item => item.failed);
  const stamp = new Date(
    options.createdAt
  ).toLocaleString("zh-CN", {
    hour12: false
  });

  const lines = [
    `# Runbook：${title}`,
    "",
    `> 由 tera-shell AI 助手于 ${stamp} 从一次会话导出${
      options.host
        ? `，目标主机 \`${options.host}\``
        : ""
    }。`,
    "> 命令已做基础脱敏（密码/令牌替换为 `***`），导出后请自行复核。",
    "",
    "## 触发场景",
    "",
    material.scene || "（本次会话没有用户提问）",
    "",
    "## 前置检查",
    "",
    renderCommands(
      material.checks,
      "（本次会话没有只读排查命令）"
    ),
    "",
    "## 命令步骤",
    "",
    renderCommands(
      material.steps,
      "（本次会话没有变更类命令）"
    ),
    "",
    "## 结论",
    "",
    material.conclusion ||
      "（本次会话没有助手结论）"
  ];

  if (material.sideEffects.length > 0) {
    lines.push(
      "",
      "## 附带影响",
      "",
      ...material.sideEffects.map(
        item => `- ${item}`
      )
    );
  }

  lines.push(
    "",
    "## 风险与回滚",
    "",
    "- 执行前先跑「前置检查」确认现场与本文一致，不一致时不要照搬。",
    "- 变更类命令建议先在测试环境验证；生产执行前确认有可用回滚手段。",
    failed.length > 0
      ? `- 本次会话中有 ${failed.length} 条命令执行失败，导出步骤时请重点关注。`
      : "- 本次会话的命令均未报告失败。",
    ""
  );

  return lines.join("\n");
}

/** 建议文件名：主机 + 日期，去掉非法字符。 */
export function runbookFileName(
  entries: AiChatEntry[],
  host: string | undefined,
  createdAt: number
): string {
  const scene = extractRunbookMaterial(
    entries
  ).scene.slice(0, 30);
  const date = new Date(createdAt);
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");
  const base = [host, scene || "runbook"]
    .filter(Boolean)
    .join("-")
    // Windows 非法字符 + 中文标点（标点虽合法，但文件名里显得脏）
    .replace(
      /[\\/:*?"<>|，。、；：！？（）【】「」《》\s]+/g,
      "-"
    )
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "runbook"}-${day}.md`;
}
