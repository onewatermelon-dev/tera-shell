/**
 * AI 面板接入外部 MCP 工具的辅助：拉取工具清单、调用外部工具。
 *
 * 后端有 `mcp_client_list_all_tools`（拉取所有外部 server 的工具，name 已带
 * `mcp__<server>__` 前缀）与 `mcp_client_call_tool`（调用单个工具）。
 * 这里封装成 AI 面板可用的纯辅助函数，不碰 React 状态。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  logInfo,
  logWarn
} from "@/shared/lib/log";
import type { ExternalTool } from "@/terminal/lib/ai/adapters";

/** 外部工具名的 `mcp__` 前缀（与后端 client.rs 一致）。 */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * 工具清单缓存：外部 server 的工具不会中途变，而每轮对话都重新
 * spawn npx 握手（~3 秒）会把模型首字延迟顶到 3-5 秒。5 分钟 TTL，
 * 设置页保存接入配置时主动失效（invalidateExternalToolsCache）。
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: {
  at: number;
  tools: ExternalTool[];
} | null = null;

/** 使工具清单缓存失效（设置页保存接入配置后调用）。 */
export function invalidateExternalToolsCache(): void {
  cache = null;
}

/**
 * 拉取所有外部 MCP server 的工具清单（带 TTL 缓存）。
 *
 * 失败（没有配置 / 后端异常）返回空数组 —— 外部工具是「锦上添花」，
 * 不该因为没有外部 server 就拖垮内置 AI 的整个请求。
 */
export async function loadExternalTools(): Promise<
  ExternalTool[]
> {
  if (
    cache &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    logInfo(
      `[mcp] 外部工具命中缓存 ${cache.tools.length} 个`
    );
    return cache.tools;
  }
  try {
    const tools = await invoke<ExternalTool[]>(
      "mcp_client_list_all_tools"
    );
    const list = Array.isArray(tools)
      ? tools
      : [];
    // 落盘可见：模型没用外部工具时，日志里先确认工具到底注入没有
    logInfo(
      `[mcp] 外部工具注入 ${list.length} 个`,
      list.map(tool => tool.name).join("、")
    );
    cache = { at: Date.now(), tools: list };
    return list;
  } catch (reason) {
    logWarn("[mcp] 拉取外部工具失败", reason);
    return [];
  }
}

/**
 * 调用一个外部 MCP 工具，返回文本结果。
 *
 * `name` 是带前缀的完整工具名，`arguments` 是模型给的参数对象。
 * 抛出的错误由调用方回填成 tool 消息，让模型看到失败原因并自行纠正。
 */
export async function callExternalTool(
  name: string,
  argumentsObj: Record<string, unknown>
): Promise<string> {
  const result = await invoke<string>(
    "mcp_client_call_tool",
    {
      name,
      arguments: argumentsObj
    }
  );
  return result;
}

/**
 * 判断一个工具名是否是外部 MCP 工具（`mcp__` 前缀）。
 */
export function isExternalTool(
  name: string
): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}
