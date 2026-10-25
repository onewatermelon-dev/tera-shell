import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import Toggle from "@/shared/components/Toggle";
import SettingsRow from "@/settings/components/SettingsRow";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import { invalidateExternalToolsCache } from "@/terminal/lib/ai/mcpTools";
import type { AppSettings } from "@/settings/lib/settings";

type McpSectionProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * MCP 配置的 JSON 片段模板（command 路径留占位符，用户按安装位置替换）。
 *
 * stdio 模式：外部 agent 拉起 `tera-shell-mcp` 子进程，子进程自己读数据
 * 目录里的 bridge 配置（端口 + token），无需在配置里写 token。
 */
const MCP_CONFIG_TEMPLATE = `{
  "mcpServers": {
    "tera-shell": {
      "command": "<安装目录>/tera-shell-mcp.exe",
      "args": []
    }
  }
}`;

/**
 * 设置页的「MCP Server」分区：开关 + 复制接入配置 + 重置令牌。
 *
 * MCP Server 让 Claude Code / Cursor 等外部 agent 调用本应用的会话查询与
 * 命令执行（命令必须经主窗口审批）。开关改动在**重启应用后生效**——
 * bridge 在启动时按设置决定是否监听。
 */
export default function McpSection({
  settings,
  onChange
}: McpSectionProps) {
  const t = useT();
  const [copied, setCopied] = useState<
    "" | "json" | "reset"
  >("");

  /** 复制一段文本到剪贴板，短暂显示「已复制」。 */
  async function copy(
    text: string,
    kind: "json" | "reset"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  /** 重置访问令牌（后端重新生成；重启后生效）。 */
  async function resetToken() {
    try {
      await invoke<string>("mcp_reset_token");
      setCopied("reset");
      setTimeout(() => setCopied(""), 2000);
    } catch (reason) {
      console.warn("[mcp] 重置令牌失败", reason);
    }
  }

  // 外部 MCP server 配置：存 mcp_servers.json，JSON 数组。
  const [serversText, setServersText] = useState(
    () => readData(DataName.mcpServers) ?? "[]"
  );
  const [serversSaved, setServersSaved] =
    useState(false);
  // 连通性检测结果（按 server 名 → 结果）。
  const [testResults, setTestResults] = useState<
    {
      name: string;
      ok: boolean;
      error: string | null;
      toolCount: number;
    }[]
  >([]);
  const [testing, setTesting] = useState(false);

  /** 保存外部 server 配置（JSON 有效即写盘；格式问题由检测结果反馈）。 */
  function saveServers() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serversText);
    } catch {
      setTestResults([
        {
          name: "-",
          ok: false,
          error: t("settings.mcp.invalidJson"),
          toolCount: 0
        }
      ]);
      return;
    }
    // 单对象（如 {"mcpServers":{…}} 或单个 server）也放行：
    // 后端 load_servers 会归一化，这里只挡 JSON 层面的错误
    if (
      typeof parsed !== "object" ||
      parsed === null
    ) {
      setTestResults([
        {
          name: "-",
          ok: false,
          error: t("settings.mcp.noServers"),
          toolCount: 0
        }
      ]);
      return;
    }
    writeData(
      DataName.mcpServers,
      JSON.stringify(parsed)
    );
    // 配置变了，AI 面板的工具清单缓存作废（下一轮对话重新拉取）
    invalidateExternalToolsCache();
    setTestResults([]);
    setServersSaved(true);
    setTimeout(
      () => setServersSaved(false),
      1500
    );
  }

  /** 检测所有配置的外部 server 连通性。 */
  async function testServers() {
    // 兼容两种写法：裸数组 [{name,...}] 与 Claude Desktop 风格
    // [{"mcpServers": {名: {...}}}]（用户从别的工具粘贴最常见）。
    // 解析出**完整条目**直接传给后端检测 —— 不查落盘文件，
    // 未保存的草稿也能测，也不存在「先保存再检测」的竞态
    type ServerEntry = {
      name: string;
      command?: string;
      args?: string[];
      url?: string;
    };
    let entries: ServerEntry[];
    try {
      const parsed: unknown =
        JSON.parse(serversText);
      const items = Array.isArray(parsed)
        ? parsed
        : [parsed];
      entries = [];
      for (const item of items) {
        if (
          typeof item !== "object" ||
          item === null
        )
          continue;
        const servers = (
          item as {
            mcpServers?: Record<string, unknown>;
          }
        ).mcpServers;
        if (
          servers &&
          typeof servers === "object"
        ) {
          for (const [
            name,
            config
          ] of Object.entries(servers)) {
            entries.push({
              name,
              ...(typeof config === "object" &&
              config !== null
                ? config
                : {})
            } as ServerEntry);
          }
          continue;
        }
        const name = (item as { name?: unknown })
          .name;
        if (typeof name === "string" && name)
          entries.push(item as ServerEntry);
      }
    } catch {
      setTestResults([
        {
          name: "-",
          ok: false,
          error: t("settings.mcp.invalidJson"),
          toolCount: 0
        }
      ]);
      return;
    }
    if (entries.length === 0) {
      setTestResults([
        {
          name: "-",
          ok: false,
          error: t("settings.mcp.noServers"),
          toolCount: 0
        }
      ]);
      return;
    }
    setTesting(true);
    setTestResults([]);
    const results = [];
    for (const config of entries) {
      try {
        const result = await invoke<{
          name: string;
          ok: boolean;
          error: string | null;
          toolCount: number;
        }>("mcp_client_test_connection", {
          config
        });
        results.push(result);
      } catch (reason) {
        results.push({
          name: config.name,
          ok: false,
          error: String(reason),
          toolCount: 0
        });
      }
    }
    setTestResults(results);
    setTesting(false);
  }

  return (
    <>
      <SettingsRow
        title={t("settings.mcp.enableTitle")}
        description={t("settings.mcp.enableDesc")}
        control={
          <Toggle
            ariaLabel={t(
              "settings.mcp.enableTitle"
            )}
            isSelected={settings.mcpEnabled}
            onChange={mcpEnabled =>
              onChange({ mcpEnabled })
            }
          />
        }
      />
      <SettingsRow
        title={t("settings.mcp.autoExecuteTitle")}
        description={t(
          "settings.mcp.autoExecuteDesc"
        )}
        control={
          <Toggle
            ariaLabel={t(
              "settings.mcp.autoExecuteTitle"
            )}
            isSelected={settings.mcpAutoExecute}
            onChange={mcpAutoExecute =>
              onChange({ mcpAutoExecute })
            }
          />
        }
      />
      <SettingsRow
        title={t("settings.mcp.autoApplyTitle")}
        description={t(
          "settings.mcp.autoApplyDesc"
        )}
        control={
          <Toggle
            ariaLabel={t(
              "settings.mcp.autoApplyTitle"
            )}
            isSelected={settings.mcpAutoApply}
            onChange={mcpAutoApply =>
              onChange({ mcpAutoApply })
            }
          />
        }
      />
      <SettingsRow
        title={t("settings.mcp.blacklistTitle")}
        description={t(
          "settings.mcp.blacklistDesc"
        )}
      >
        <input
          className="settings-input"
          value={settings.mcpBlacklist.join(", ")}
          spellCheck={false}
          aria-label={t(
            "settings.mcp.blacklistTitle"
          )}
          placeholder={t(
            "settings.mcp.blacklistPlaceholder"
          )}
          onChange={event =>
            onChange({
              mcpBlacklist: event.target.value
                .split(/[,，\s]+/)
                .map(s => s.trim().toLowerCase())
                .filter(Boolean)
            })
          }
        />
      </SettingsRow>
      {/* 访问令牌放接入配置上面：外部工具接入时先看 token 再拿配置 */}
      <SettingsRow
        title={t("settings.mcp.resetTitle")}
        description={t("settings.mcp.resetDesc")}
        control={
          <Button
            variant="tertiary"
            size="sm"
            onPress={() => void resetToken()}
          >
            {copied === "reset"
              ? t("settings.mcp.resetDone")
              : t("settings.mcp.reset")}
          </Button>
        }
      />
      <SettingsRow
        title={t("settings.mcp.configTitle")}
        description={t("settings.mcp.configDesc")}
        control={
          <Button
            variant="tertiary"
            size="sm"
            onPress={() =>
              void copy(
                MCP_CONFIG_TEMPLATE,
                "json"
              )
            }
          >
            {copied === "json"
              ? t("settings.mcp.copied")
              : t("settings.mcp.copyConfig")}
          </Button>
        }
      >
        <pre className="mcp-config-snippet">
          {MCP_CONFIG_TEMPLATE}
        </pre>
      </SettingsRow>
      <SettingsRow
        title={t("settings.mcp.clientTitle")}
        description={t("settings.mcp.clientDesc")}
        control={
          <div className="mcp-client-actions">
            <Button
              variant="tertiary"
              size="sm"
              onPress={saveServers}
            >
              {serversSaved
                ? t("settings.mcp.copied")
                : t("settings.mcp.saveServers")}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={testing}
              onPress={() => void testServers()}
            >
              {testing
                ? t("settings.mcp.testing")
                : t("settings.mcp.test")}
            </Button>
          </div>
        }
      >
        <textarea
          className="mcp-servers-input"
          value={serversText}
          spellCheck={false}
          aria-label={t(
            "settings.mcp.clientTitle"
          )}
          rows={6}
          onChange={event =>
            setServersText(event.target.value)
          }
        />
        {testResults.length > 0 && (
          <div className="mcp-test-results">
            {testResults.map(result => (
              <div
                key={result.name}
                className={`mcp-test-result ${
                  result.ok ? "is-ok" : "is-fail"
                }`}
              >
                <span className="mcp-test-name">
                  {result.name}
                </span>
                {result.ok ? (
                  <span className="mcp-test-ok">
                    {t("settings.mcp.testOk", {
                      count: result.toolCount
                    })}
                  </span>
                ) : (
                  <span className="mcp-test-error">
                    {result.error ??
                      t("settings.mcp.testFail")}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsRow>
    </>
  );
}
