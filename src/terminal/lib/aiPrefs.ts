/**
 * AI 面板的用户偏好落盘：上次选中的模型、执行策略开关、自动执行
 * 黑名单、面板宽度。统一存进数据目录的 `ai_prefs.json`（storage 层），
 * 跟会话/设置一样跟着数据目录迁移 —— 此前这些散在 WebView 的
 * localStorage 里，换数据目录或清 WebView 缓存就会丢。
 *
 * 读取侧保持各功能原有的 `loadXxx/saveXxx` 签名（见 aiChat.ts），
 * 调用方无感。首启动时把旧 localStorage 值一次性搬进来（readPrefs
 * 内自清空，跑几次都安全）。
 */

import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/** AI 面板偏好的落盘结构。字段缺省 = 用各 load 函数的默认值。 */
export type AiPrefs = {
  /** 上次选中的模型（providerId::modelId）。 */
  selectedModel?: string;
  /** 自动执行只读命令开关。 */
  autoExecute?: boolean;
  /** 自动应用文件更改开关。 */
  autoApply?: boolean;
  /** 自动执行命令黑名单（命令名数组，如 ["rm", "kill"]）。 */
  blacklist?: string[];
  /** AI 面板宽度（px）。 */
  panelWidth?: number;
};

/** 旧版 localStorage 键 → 偏好字段的迁移映射（键名即历史，别再复用）。 */
const LEGACY_KEYS = {
  selectedModel: "ai-selected-model",
  autoExecute: "ai-auto-execute-v2",
  autoApply: "ai-auto-apply-v2",
  blacklist: "ai-cmd-blacklist",
  panelWidth: "ai-panel-width"
} as const;

/**
 * 读取偏好对象；损坏或没有时返回空对象。
 *
 * 顺带把旧 localStorage 的值迁移进来：只在对应字段还没落盘时搬一次，
 * 搬完无条件删掉旧键 —— 之后每次启动这里都是空跑。
 */
function readPrefs(): AiPrefs {
  let prefs: AiPrefs = {};
  try {
    const raw = readData(DataName.aiPrefs);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null
      ) {
        prefs = parsed as AiPrefs;
      }
    }
  } catch (reason) {
    console.warn(
      "[ai-prefs] 偏好解析失败",
      reason
    );
  }
  try {
    const picked: AiPrefs = {};
    const model = localStorage.getItem(
      LEGACY_KEYS.selectedModel
    );
    if (model !== null)
      picked.selectedModel = model;
    const execute = localStorage.getItem(
      LEGACY_KEYS.autoExecute
    );
    if (execute !== null)
      picked.autoExecute = execute === "1";
    const apply = localStorage.getItem(
      LEGACY_KEYS.autoApply
    );
    if (apply !== null)
      picked.autoApply = apply === "1";
    const blacklist = localStorage.getItem(
      LEGACY_KEYS.blacklist
    );
    if (blacklist !== null) {
      const list: unknown = JSON.parse(blacklist);
      if (Array.isArray(list))
        picked.blacklist = list.filter(
          (item): item is string =>
            typeof item === "string"
        );
    }
    const width = Number(
      localStorage.getItem(LEGACY_KEYS.panelWidth)
    );
    if (Number.isFinite(width) && width > 0)
      picked.panelWidth = width;
    // 只补还没落盘的字段：文件已是真相的字段不回退
    // （picked 的值本身已过滤掉 null/非法项，展开即「缺才补」）
    prefs = { ...picked, ...prefs };
    for (const key of Object.values(
      LEGACY_KEYS
    )) {
      localStorage.removeItem(key);
    }
    if (Object.keys(picked).length > 0) {
      writeData(
        DataName.aiPrefs,
        JSON.stringify(prefs)
      );
      console.info(
        "[ai-prefs] 已迁移旧 localStorage 偏好",
        Object.keys(picked)
      );
    }
  } catch (reason) {
    // localStorage 不可用（老 WebView 隐私模式等）时跳过迁移，文件值照常
    console.warn(
      "[ai-prefs] 旧偏好迁移跳过",
      reason
    );
  }
  return prefs;
}

/** 合并写入偏好：内存立即生效，磁盘异步跟上（storage 层语义）。 */
function writePrefs(
  patch: Partial<AiPrefs>
): void {
  writeData(
    DataName.aiPrefs,
    JSON.stringify({
      ...readPrefs(),
      ...patch
    })
  );
}

/** 上次选中的模型；没有返回 null。 */
export function loadSelectedModel():
  string | null {
  return readPrefs().selectedModel ?? null;
}

/** 记住上次选中的模型（providerId::modelId）。 */
export function saveSelectedModel(
  value: string
): void {
  writePrefs({ selectedModel: value });
}

/** 读取执行策略开关；未设置过为关。 */
export function loadRunFlag(
  name: "autoExecute" | "autoApply"
): boolean {
  return readPrefs()[name] === true;
}

/** 保存执行策略开关。 */
export function saveRunFlag(
  name: "autoExecute" | "autoApply",
  value: boolean
): void {
  writePrefs({ [name]: value });
}

/** 读取自动执行命令黑名单；未设置过为空。 */
export function loadBlacklist(): string[] {
  const list = readPrefs().blacklist;
  return Array.isArray(list) ? list : [];
}

/** 保存自动执行命令黑名单。 */
export function saveBlacklist(
  list: string[]
): void {
  writePrefs({ blacklist: list });
}

/** 读取 AI 面板宽度；未设置过返回 null，由调用方决定兜底值。 */
export function loadPanelWidth(): number | null {
  return readPrefs().panelWidth ?? null;
}

/** 记住 AI 面板宽度（拖拽结束时调用）。 */
export function savePanelWidth(
  width: number
): void {
  writePrefs({ panelWidth: width });
}
