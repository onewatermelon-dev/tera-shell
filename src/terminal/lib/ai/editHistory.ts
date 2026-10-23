/**
 * AI 改文件的变更历史（落盘 edit_history.json）。
 *
 * 每次批准写入前把原文与新文记下来，改动不符合预期时一键回滚 ——
 * 回滚就是把原文再写一次（writeRemoteFileText），不引入新的文件通道。
 * 备份只存本地（这份 JSON），不在远端服务器上留备份文件。
 *
 * 容量口径：最多留 50 条；单条新旧内容合计超过 128KB 就不存原文
 * （历史里仍记录文件与时间，只是不给回滚）。
 */
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import { logError } from "@/shared/lib/log";
import { writeRemoteFileText } from "./fileEditExec";
import type { OpenSession } from "../session/terminalTypes";
import type { SshTarget } from "@/sessions/lib/sshTarget";

/** 历史条目上限；超出时丢最旧的。 */
const MAX_ENTRIES = 50;
/** 新旧内容合计上限，超过就不存原文（该条不可回滚）。 */
const MAX_CONTENT_BYTES = 128 * 1024;

export type EditHistoryEntry = {
  id: string;
  /** 毫秒时间戳 */
  time: number;
  /** `user@host:port`，回滚时与当前会话比对 */
  hostKey: string;
  /** 展示用的会话名 */
  sessionName: string;
  path: string;
  /** 兼容早期远端备份方案的遗留字段，恒为 null（备份只存本地） */
  backupPath: string | null;
  /** 写入前原文；null = 内容过大未留存 */
  oldContent: string | null;
  newContent: string | null;
  added: number;
  removed: number;
  /** 已回滚过 */
  rolledBack: boolean;
};

/** exec 通道的连接标识，回滚前与历史条目比对。 */
export function hostKeyOf(target: {
  username: string;
  host: string;
  port: number;
}): string {
  return `${target.username}@${target.host}:${target.port}`;
}

/**
 * 这条历史能不能在当前会话里回滚：会话在同一台主机、原文留存、
 * 会话的 exec 通道就绪且尚未回滚过。
 */
export function canRollback(
  entry: EditHistoryEntry,
  session:
    | { execTarget?: SshTarget; id: string }
    | null
    | undefined
): boolean {
  if (
    entry.rolledBack ||
    !entry.oldContent ||
    !session?.execTarget
  )
    return false;
  return (
    hostKeyOf(session.execTarget) ===
    entry.hostKey
  );
}

/** 读全部历史（最新的在前）。 */
export function loadEditHistory(): EditHistoryEntry[] {
  try {
    const raw = readData(DataName.editHistory);
    const list = raw
      ? (JSON.parse(raw) as EditHistoryEntry[])
      : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 记一条变更，返回条目 id（diff 卡上的回滚按钮按它定位）。
 * 失败只记日志返回 null —— 历史是保险，不能因为它打断主流程。
 */
export function recordEditHistory(input: {
  session: OpenSession | undefined;
  path: string;
  oldContent: string;
  newContent: string;
  added: number;
  removed: number;
}): string | null {
  try {
    const session = input.session;
    const execTarget = session?.execTarget;
    if (!execTarget) return null;
    const total =
      input.oldContent.length +
      input.newContent.length;
    const entry: EditHistoryEntry = {
      id: crypto.randomUUID(),
      time: Date.now(),
      hostKey: hostKeyOf(execTarget),
      sessionName: session?.name ?? "",
      path: input.path,
      backupPath: null,
      oldContent:
        total <= MAX_CONTENT_BYTES
          ? input.oldContent
          : null,
      newContent:
        total <= MAX_CONTENT_BYTES
          ? input.newContent
          : null,
      added: input.added,
      removed: input.removed,
      rolledBack: false
    };
    const next = [
      entry,
      ...loadEditHistory()
    ].slice(0, MAX_ENTRIES);
    writeData(
      DataName.editHistory,
      JSON.stringify(next)
    );
    return entry.id;
  } catch (reason) {
    logError(
      "[ai-edit] 变更历史记录失败",
      reason
    );
    return null;
  }
}

/** 标记某条已回滚（落盘，失败只记日志）。 */
function markRolledBack(id: string): void {
  try {
    const next = loadEditHistory().map(item =>
      item.id === id
        ? { ...item, rolledBack: true }
        : item
    );
    writeData(
      DataName.editHistory,
      JSON.stringify(next)
    );
  } catch (reason) {
    logError(
      "[ai-edit] 回滚标记落盘失败",
      reason
    );
  }
}

/**
 * 一键回滚：把原文再写一次。返回抛错即回滚失败（错误透传给 UI）。
 */
export async function rollbackEdit(
  entry: EditHistoryEntry,
  session: OpenSession | undefined
): Promise<void> {
  if (!entry.oldContent)
    throw new Error(
      "该条历史未留存原文，无法回滚"
    );
  await writeRemoteFileText(
    session,
    entry.path,
    entry.oldContent
  );
  markRolledBack(entry.id);
}
