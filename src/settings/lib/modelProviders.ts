import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/**
 * 模型供应商：Base URL + Key + 模型列表。
 *
 * 存文件（键 `models`），与会话 / 设置 / 宏同一套存储层；
 * 这里是「跟着这台机器的人走」的配置，不跟项目走。
 */

/** API 格式：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses。 */
export type ApiFormat =
  "anthropic" | "openai" | "responses";

/** 供应商下的一个模型条目。 */
export type ModelEntry = {
  /** 稳定标识，用于列表 key 与增删改定位 */
  id: string;
  /** 模型名（如 qwen3.8-flash），留空表示还没填 */
  name: string;
  /** 是否启用；停用的模型不出现在选择列表里 */
  enabled: boolean;
  /** 智能配置开关（仅记录，暂无行为挂钩） */
  smartConfig: boolean;
  /** 上下文窗口，自由文本（如 1M、128000） */
  contextWindow: string;
  /** 最大输出 Token，自由文本 */
  maxOutputTokens: string;
  /** 输入类型：text 恒选中且锁定，image / video / pdf 可选 */
  inputTypes: string[];
  /** 模型能力：structured / webSearch / systemMessages */
  capabilities: string[];
  /** 推理等级（从低到高），有序字符串列表 */
  reasoningLevels: string[];
  /** 推理参数映射，自由文本 */
  reasoningMapping: string;
};

/** 新增模型时的草稿（id 由存储层生成）。 */
export type ModelDraft = Omit<ModelEntry, "id">;

/**
 * 上下文窗口的展示缩写：纯数字换算成 K / M（如 1000000 → 1M、
 * 262144 → 262.1K），非数字（"1M"、空串）原样返回。
 */
export function formatContextWindow(
  raw: string
): string {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return raw;
  const abbrev = (value: number, unit: string) =>
    `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (n >= 1_000_000)
    return abbrev(n / 1_000_000, "M");
  if (n >= 1_000) return abbrev(n / 1_000, "K");
  return String(n);
}

/** 新模型 / 老文件缺字段时的默认值。 */
export function defaultModelDraft(): ModelDraft {
  return {
    name: "",
    enabled: true,
    smartConfig: true,
    contextWindow: "",
    maxOutputTokens: "",
    inputTypes: ["text"],
    capabilities: [],
    reasoningLevels: [],
    reasoningMapping: ""
  };
}

/** 一个模型供应商。 */
export type ModelProvider = {
  id: string;
  name: string;
  /** 接口根地址，如 https://example.com/compatible-mode/v1 */
  baseUrl: string;
  apiFormat: ApiFormat;
  apiKey: string;
  enabled: boolean;
  models: ModelEntry[];
};

/** 生成供应商 / 模型 id（与宏同一套做法）。 */
export function createModelId(
  prefix: string
): string {
  return `${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 读取供应商列表；任何异常都视为「还没配置过」。 */
export function loadProviders(): ModelProvider[] {
  try {
    const raw = readData(DataName.models);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ModelProvider =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as ModelProvider).id ===
            "string" &&
          typeof (item as ModelProvider).name ===
            "string" &&
          Array.isArray(
            (item as ModelProvider).models
          )
      )
      .map(provider => ({
        ...provider,
        // 逐字段兜底：老文件 / 手改过的文件可能缺字段，
        // 宁可退回默认值也不让渲染拿到 undefined
        baseUrl:
          typeof provider.baseUrl === "string"
            ? provider.baseUrl
            : "",
        apiKey:
          typeof provider.apiKey === "string"
            ? provider.apiKey
            : "",
        apiFormat:
          provider.apiFormat === "anthropic" ||
          provider.apiFormat === "responses"
            ? provider.apiFormat
            : "openai",
        enabled: provider.enabled !== false,
        models: provider.models
          .filter(
            (model): model is ModelEntry =>
              typeof model === "object" &&
              model !== null &&
              typeof model.id === "string" &&
              typeof model.name === "string"
          )
          .map(model => {
            // 数字也收：手改 JSON 填 1000000 不该被当缺字段丢掉
            const text = (value: unknown) =>
              typeof value === "string"
                ? value
                : typeof value === "number" &&
                    Number.isFinite(value)
                  ? String(value)
                  : "";
            const list = (value: unknown) =>
              Array.isArray(value)
                ? value.filter(
                    (item): item is string =>
                      typeof item === "string"
                  )
                : [];
            return {
              ...defaultModelDraft(),
              ...model,
              enabled: model.enabled !== false,
              smartConfig:
                model.smartConfig !== false,
              contextWindow: text(
                model.contextWindow
              ),
              maxOutputTokens: text(
                model.maxOutputTokens
              ),
              inputTypes: list(model.inputTypes),
              capabilities: list(
                model.capabilities
              ),
              reasoningLevels: list(
                model.reasoningLevels
              ),
              reasoningMapping: text(
                model.reasoningMapping
              )
            };
          })
      }));
  } catch {
    return [];
  }
}

/** 供应商配置变更的 window 事件名：所有消费方监听它即时刷新。 */
export const PROVIDERS_CHANGED_EVENT =
  "model-providers-changed";

/** 保存供应商列表；写盘失败只记日志，不影响本次会话的使用。 */
export function saveProviders(
  providers: ModelProvider[]
): void {
  writeData(
    DataName.models,
    JSON.stringify(providers)
  );
  // 同一文档内 storage 事件不会自己触发，广播给 AI 面板等消费方
  window.dispatchEvent(
    new Event(PROVIDERS_CHANGED_EVENT)
  );
}
