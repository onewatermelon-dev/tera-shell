import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import Toggle from "@/shared/components/Toggle";
import SettingsRow from "@/settings/components/SettingsRow";
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
    </>
  );
}
