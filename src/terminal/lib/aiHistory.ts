/**
 * AI 对话历史（「历史任务」）：按会话自动落盘，可恢复继续对话。
 *
 * 存储走统一数据层（storage.ts → 后端 ai_history.json），与会话 / 设置 /
 * 快捷宏 / 模型供应商一起被导出、清理与迁移；messages 是协议消息快照
 * （恢复后能接着聊），entries 是面板展示快照。两者按 unknown[] 存，
 * 类型收口在 aiChat 的 restore 里。
 */
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/** 旧版直接存 localStorage 的键：首次读取时一次性迁移。 */
const LEGACY_KEY = "ai-chat-history";

/** 历史条数上限：超出丢最旧的。 */
const MAX_HISTORY = 30;

export type AiHistory = {
  id: string;
  /** 标题：首条用户消息截断 */
  title: string;
  /** 归属服务器（恢复列表只显示当前会话所在服务器的历史） */
  host: string;
  updatedAt: number;
  entries: unknown[];
  messages: unknown[];
};

function parseList(
  raw: string | null
): AiHistory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AiHistory[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (reason) {
    console.error(
      "[ai-history] 历史数据解析失败",
      reason
    );
    return [];
  }
}

/** 读取全部历史；顺带把旧版 localStorage 数据迁移进来。 */
export function loadHistories(): AiHistory[] {
  const list = parseList(
    readData(DataName.aiHistory)
  );
  if (list.length > 0) return list;
  // 一次性迁移：老用户升级后历史不丢
  try {
    const legacy = parseList(
      localStorage.getItem(LEGACY_KEY)
    );
    if (legacy.length > 0) {
      writeData(
        DataName.aiHistory,
        JSON.stringify(legacy)
      );
      localStorage.removeItem(LEGACY_KEY);
      console.info(
        "[ai-history] 已迁移旧历史",
        legacy.length,
        "条"
      );
      return legacy;
    }
  } catch (reason) {
    console.error(
      "[ai-history] 迁移旧历史失败",
      reason
    );
  }
  return list;
}

/** 整体写回历史列表（删除 / 重命名共用）。 */
function writeHistories(list: AiHistory[]): void {
  writeData(
    DataName.aiHistory,
    JSON.stringify(list)
  );
}

/** 删除一条历史。 */
export function deleteHistory(id: string): void {
  writeHistories(
    loadHistories().filter(item => item.id !== id)
  );
}

/** 重命名一条历史；名称留空则不改，过长截断。 */
export function renameHistory(
  id: string,
  title: string
): void {
  const trimmed = title.trim().slice(0, 40);
  if (!trimmed) return;
  writeHistories(
    loadHistories().map(item =>
      item.id === id
        ? { ...item, title: trimmed }
        : item
    )
  );
}

/** 新增或按 id 更新一条历史，保持按更新时间倒序。 */
export function saveHistory(
  history: AiHistory
): void {
  const rest = loadHistories().filter(
    item => item.id !== history.id
  );
  const next = [history, ...rest].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  writeHistories(next.slice(0, MAX_HISTORY));
}
