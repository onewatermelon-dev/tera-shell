/**
 * AI 面板接入外部 MCP 工具的辅助：拉取工具清单、调用外部工具。
 *
 * 后端有 `mcp_client_list_all_tools`（拉取所有外部 server 的工具，name 已带
 * `mcp__<server>__` 前缀）与 `mcp_client_call_tool`（调用单个工具）。
 * 这里封装成 AI 面板可用的纯辅助函数，不碰 React 状态。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ExternalTool } from "@/terminal/lib/ai/adapters";

/** 外部工具名的 `mcp__` 前缀（与后端 client.rs 一致）。 */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * 拉取所有外部 MCP server 的工具清单。
 *
 * 失败（没有配置 / 后端异常）返回空数组 —— 外部工具是「锦上添花」，
 * 不该因为没有外部 server 就拖垮内置 AI 的整个请求。
 */
export async function loadExternalTools(): Promise<
  ExternalTool[]
> {
  try {
    const tools = await invoke<ExternalTool[]>(
      "mcp_client_list_all_tools"
    );
    return Array.isArray(tools) ? tools : [];
  } catch (reason) {
    console.warn(
      "[mcp] 拉取外部工具失败",
      reason
    );
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
