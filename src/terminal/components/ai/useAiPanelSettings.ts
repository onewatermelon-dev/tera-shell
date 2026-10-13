/**
 * AI 面板的设置态：模型列表与选中、执行策略开关、黑名单。
 *
 * 从 AiPanel.tsx 拆出（2026-10-13）。这些状态都「即改即存」到数据
 * 目录（ai_prefs.json），并监听设置页的供应商变更事件即时刷新。
 */
import { useEffect, useState } from "react";
import { PROVIDERS_CHANGED_EVENT } from "@/settings/lib/modelProviders";
import {
  listOpenAiModels,
  loadBlacklist,
  loadRunFlag,
  loadSelectedModel,
  saveBlacklist,
  saveRunFlag,
  saveSelectedModel,
  type AiModelOption
} from "@/terminal/lib/ai/aiChat";

export function useAiPanelSettings() {
  // 供应商/模型在设置页即改即存，监听变更事件即时刷新「+」菜单
  const [options, setOptions] = useState(
    listOpenAiModels
  );
  useEffect(() => {
    const refresh = () =>
      setOptions(listOpenAiModels());
    window.addEventListener(
      PROVIDERS_CHANGED_EVENT,
      refresh
    );
    return () =>
      window.removeEventListener(
        PROVIDERS_CHANGED_EVENT,
        refresh
      );
  }, []);
  const [selectedKey, setSelectedKey] = useState(
    () => loadSelectedModel() ?? ""
  );
  // 「+」菜单里的执行策略开关（持久化，默认都关）
  const [autoExecute, setAutoExecute] = useState(
    () => loadRunFlag("autoExecute")
  );
  // 开启「自动执行」前的安全确认弹窗
  const [riskOpen, setRiskOpen] = useState(false);
  const [autoApply, setAutoApply] = useState(() =>
    loadRunFlag("autoApply")
  );
  // 自动执行命令黑名单：命中即不出执行卡自动跑，回落为人工确认
  const [blacklist, setBlacklist] = useState(
    loadBlacklist
  );
  const [blacklistOpen, setBlacklistOpen] =
    useState(false);
  /** 增删黑名单条目并持久化。 */
  function updateBlacklist(list: string[]) {
    setBlacklist(list);
    saveBlacklist(list);
  }
  // 上次选中的模型可能已被删掉：找不到就退回第一个可选项
  const selected: AiModelOption | null =
    options.find(
      o =>
        `${o.providerId}::${o.modelId}` ===
        selectedKey
    ) ??
    options[0] ??
    null;

  function pickModel(value: string) {
    setSelectedKey(value);
    saveSelectedModel(value);
  }

  function toggleAutoExecute(value: boolean) {
    // 开启需过安全确认弹窗；关闭直接生效
    if (value) {
      setRiskOpen(true);
      return;
    }
    setAutoExecute(false);
    saveRunFlag("autoExecute", false);
  }

  function confirmAutoExecute() {
    setAutoExecute(true);
    saveRunFlag("autoExecute", true);
  }

  function toggleAutoApply(value: boolean) {
    setAutoApply(value);
    saveRunFlag("autoApply", value);
  }

  return {
    options,
    selected,
    autoExecute,
    autoApply,
    blacklist,
    riskOpen,
    setRiskOpen,
    blacklistOpen,
    setBlacklistOpen,
    updateBlacklist,
    pickModel,
    toggleAutoExecute,
    confirmAutoExecute,
    toggleAutoApply
  };
}
