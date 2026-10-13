/**
 * AI 模型与工具调用的辅助函数：可选模型枚举、命令黑名单判定、
 * tool_call 参数解析、终端目录读取与命令包装。
 *
 * 从 aiChat.ts 拆出。除 listOpenAiModels 读设置外都是纯函数。
 */
import type { Terminal } from "@xterm/xterm";
import {
  loadProviders,
  type ModelEntry,
  type ModelProvider
} from "@/settings/lib/modelProviders";

/** 可选中的模型：供应商 × 模型。 */
export type AiModelOption = {
  providerId: string;
  modelId: string;
  /** 下拉展示文本：供应商 / 模型 */
  label: string;
  provider: ModelProvider;
  model: ModelEntry;
};

/** 列出可用的聊天模型：三种 API 格式都支持（面板下拉数据源）。 */
export function listOpenAiModels(): AiModelOption[] {
  return loadProviders()
    .filter(p => p.enabled)
    .flatMap(provider =>
      provider.models
        .filter(m => m.enabled && m.name.trim())
        .map(model => ({
          providerId: provider.id,
          modelId: model.id,
          label: `${provider.name} / ${model.name}`,
          provider,
          model
        }))
    );
}

/**
 * 命令是否命中黑名单：扫描命令里**每一个**词的 basename（含 && ; | 管道
 * 拆出的后续命令与 sudo/env 前缀后的真命令）比对黑名单——复合命令
 * （`cd /root && rm -rf x`、`sh -c "rm ..."`）只看首词必然漏检。
 */
export function isBlacklisted(
  command: string,
  blacklist: string[]
): boolean {
  if (blacklist.length === 0) return false;
  const SKIP = new Set([
    "sudo",
    "doas",
    "env",
    "sh",
    "bash",
    "nohup",
    "xargs",
    "timeout"
  ]);
  for (const token of command
    .trim()
    .split(/[\s;&|]+/)) {
    const name = token
      .replace(/["']/g, "")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.toLowerCase();
    if (!name) continue;
    if (SKIP.has(name)) continue;
    if (blacklist.includes(name)) return true;
  }
  return false;
}

/** 解析模型的 tool_call 参数；参数不合法时给出可读错误。 */
export function parseToolArguments(raw: string): {
  command: string;
  question: string;
  isReadOnly: boolean;
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const command =
      typeof parsed.command === "string"
        ? parsed.command
        : "";
    if (!command.trim()) return null;
    return {
      command,
      question:
        typeof parsed.question === "string"
          ? parsed.question
          : "",
      isReadOnly: parsed.is_read_only === true
    };
  } catch {
    return null;
  }
}

/**
 * 解析文件传输工具的参数（`upload_local_file` / `download_remote_file`）。
 *
 * ⚠️ 只有 `remote_path`，**没有本地路径** —— 本地文件由用户在系统弹窗里
 * 亲自挑（见 `adapters.ts` 里 schema 的注释）。远程路径必须是绝对路径：
 * 模型的工作目录概念不可靠，相对路径会传到意想不到的地方。
 */
export function parseFileToolArguments(
  raw: string
): {
  remotePath: string;
  question: string;
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const remotePath =
      typeof parsed.remote_path === "string"
        ? parsed.remote_path.trim()
        : "";
    if (!isAbsoluteRemotePath(remotePath))
      return null;
    return {
      remotePath,
      question:
        typeof parsed.question === "string"
          ? parsed.question
          : ""
    };
  } catch {
    return null;
  }
}

/**
 * 远程路径是否可用：必须是绝对路径（Linux `/`、Windows 盘符或 UNC）。
 *
 * 挡掉 `../../etc/passwd`、`~root/.ssh/id_rsa` 这类 —— 前者靠相对路径
 * 逃出预期目录，后者是 ssh 的波浪号展开语法，很多远程 shell 不认，
 * 直接当字面目录名会传到别处去。
 */
export function isAbsoluteRemotePath(
  value: string
): boolean {
  if (!value) return false;
  if (value.startsWith("/")) return true;
  // UNC：`\\server\share`（Windows 与 Samba 共享）
  if (/^[\\/]{2}[^\\/]/.test(value)) return true;
  // Windows 盘符 `C:\...`；`C:a` 是盘符相对路径，不算绝对
  return /^[a-zA-Z]:[\\/]/.test(value);
}

/** 从当前终端提示符读取目录；没有可识别的提示符时返回 null。 */
export function directoryFromPrompt(
  terminal: Terminal | undefined
): string | null {
  if (!terminal) return null;
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(
    buffer.baseY + buffer.cursorY
  );
  const text =
    line?.translateToString(true) ?? "";
  return (
    text.match(
      /(?:^|\s)[^\s@]+@[^\s:]+:(~(?:\/[^\s#$]*)?|\/[^\s#$]*)[#$](?:\s|$)/
    )?.[1] ?? null
  );
}

/** 安全地把提示符目录拼进独立 SSH 命令。 */
export function commandInDirectory(
  directory: string,
  command: string
): string {
  const quote = (value: string) =>
    `'${value.replace(/'/g, `'\\''`)}'`;
  const path =
    directory === "~"
      ? '"$HOME"'
      : directory.startsWith("~/")
        ? `"$HOME"/${quote(directory.slice(2))}`
        : quote(directory);
  return `cd -- ${path} || exit 1\n${command}`;
}
