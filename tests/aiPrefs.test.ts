/**
 * AI 面板偏好迁移测试：旧 localStorage 的五项偏好搬进 ai_prefs 文件后
 * 旧键清空、读取端拿到原值；之后正常读写走存储层缓存。
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  clearData,
  DataName,
  readData
} from "@/settings/lib/storage";
import {
  loadBlacklist,
  loadPanelWidth,
  loadRunFlag,
  loadSelectedModel,
  saveBlacklist,
  savePanelWidth
} from "@/terminal/lib/aiPrefs";

/** localStorage 的 node 内存替身（vitest node 环境没有这个全局）。 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) =>
    store.get(key) ?? null,
  setItem: (key: string, value: string) =>
    store.set(key, value),
  removeItem: (key: string) => {
    store.delete(key);
  }
});

// 存储层缓存是模块级的，用例间清掉免得互相串值
beforeEach(() => {
  store.clear();
  clearData(DataName.aiPrefs);
});

describe("aiPrefs 旧 localStorage 迁移", () => {
  it("五项旧偏好全部搬进文件，旧键清空", () => {
    store.set("ai-selected-model", "p1::m1");
    store.set("ai-auto-execute-v2", "1");
    store.set("ai-auto-apply-v2", "0");
    store.set(
      "ai-cmd-blacklist",
      JSON.stringify(["rm", "kill"])
    );
    store.set("ai-panel-width", "520");

    expect(loadSelectedModel()).toBe("p1::m1");
    expect(loadRunFlag("autoExecute")).toBe(true);
    expect(loadRunFlag("autoApply")).toBe(false);
    expect(loadBlacklist()).toEqual([
      "rm",
      "kill"
    ]);
    expect(loadPanelWidth()).toBe(520);

    expect(store.size).toBe(0);
    const persisted = JSON.parse(
      readData(DataName.aiPrefs) ?? "{}"
    ) as Record<string, unknown>;
    expect(persisted.selectedModel).toBe(
      "p1::m1"
    );
    expect(persisted.panelWidth).toBe(520);
  });

  it("迁移后再写入走文件缓存，读取拿到新值", () => {
    saveBlacklist(["docker"]);
    expect(loadBlacklist()).toEqual(["docker"]);
    savePanelWidth(640);
    expect(loadPanelWidth()).toBe(640);
  });

  it("没有旧数据且未设置过时给默认值", () => {
    store.clear();
    expect(loadSelectedModel()).toBeNull();
    expect(loadRunFlag("autoExecute")).toBe(
      false
    );
    expect(loadBlacklist()).toEqual([]);
  });
});
