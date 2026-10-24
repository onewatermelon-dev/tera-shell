/**
 * 主机档案：每台主机一份 Markdown，用户手写沉淀「这台机器的坑」。
 *
 * 档案在每次 AI 请求时截断注入上下文（workspaceContext），模型开口前
 * 就知道角色、关键路径、已知坑 —— 不用每轮重新踩一遍。存本机
 * `host_notes.json`（`hostKey → Markdown`），跟数据目录一起迁移。
 *
 * 结构刻意保持「一坨自由文本」：用户想写什么写什么，不做结构化字段
 * —— 结构化编辑器是另一个产品的工作量，Markdown 够用且可导出。
 */
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/** 注入上下文的摘要上限（字符）：档案写太长不能吃掉对话 token。 */
const SUMMARY_LIMIT = 800;

/** 全部档案：hostKey → Markdown 文本。 */
type HostNotes = Record<string, string>;

/**
 * 会话的主机标识。与变更历史（editHistory.hostKeyOf）同一口径：
 * 远程是 `user@host:port`，本地会话是 `local`。
 */
export function hostKeyOfSession(
  session:
    | {
        kind?: string;
        username?: string;
        host: string;
        port?: number;
      }
    | null
    | undefined
): string {
  if (!session) return "";
  if (session.kind === "local") return "local";
  return `${session.username ?? ""}@${session.host}:${session.port ?? 22}`;
}

function loadAll(): HostNotes {
  try {
    const raw = readData(DataName.hostNotes);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object"
      ? (parsed as HostNotes)
      : {};
  } catch {
    return {};
  }
}

/** 读一台主机的档案全文；没有则空串。 */
export function loadHostNote(
  hostKey: string
): string {
  return loadAll()[hostKey] ?? "";
}

/** 保存一台主机的档案（整篇覆盖，textarea 直改）。 */
export function saveHostNote(
  hostKey: string,
  markdown: string
): void {
  const all = loadAll();
  const trimmed = markdown.trim();
  if (trimmed) {
    all[hostKey] = trimmed;
  } else {
    // 清空保存 = 删掉档案，别留空串占位
    delete all[hostKey];
  }
  writeData(
    DataName.hostNotes,
    JSON.stringify(all)
  );
}

/**
 * 注入上下文用的摘要：全文超出上限就硬截断（Markdown 头部通常是
 * 角色与路径这类最值钱的，尾部多是越积越多的流水，截尾损失最小）。
 */
export function hostNoteSummary(
  hostKey: string
): string {
  const note = loadHostNote(hostKey);
  if (!note) return "";
  if (note.length <= SUMMARY_LIMIT) return note;
  return `${note.slice(0, SUMMARY_LIMIT)}\n…（档案过长已截断，全文见 AI 面板的主机档案）`;
}
