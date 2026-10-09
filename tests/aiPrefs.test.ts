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
  readData,
  writeData
} from "@/settings/lib/storage";
import {
  loadBlacklist,
  loadPanelWidth,
  loadReopenTabTop,
  loadRunFlag,
  loadSelectedModel,
  saveBlacklist,
  savePanelWidth,
  saveReopenTabTop
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

/**
 * 收起后浮窗按钮的垂直位置。
 *
 * null 是**有意义的值**（= 交给 CSS 垂直居中），不是「没设置」——
 * 所以存取两端都要能原样往返 null，脏值则一律退回 null
 * （否则一个坏数据会把按钮钉到屏幕外找不回来）。
 */
describe("aiPrefs 收起浮窗位置", () => {
  it("未设置过时为 null（走 CSS 垂直居中）", () => {
    expect(loadReopenTabTop()).toBeNull();
  });

  it("写入后能原样读回", () => {
    saveReopenTabTop(240);
    expect(loadReopenTabTop()).toBe(240);
    const persisted = JSON.parse(
      readData(DataName.aiPrefs) ?? "{}"
    ) as Record<string, unknown>;
    expect(persisted.reopenTabTop).toBe(240);
  });

  it("null 也能往返：拖回中部后要真的存成 null", () => {
    saveReopenTabTop(240);
    saveReopenTabTop(null);
    expect(loadReopenTabTop()).toBeNull();
    // ⚠️ 不能被 undefined / 0 顶替：`undefined` 会让 JSON 里丢掉这个键，
    // 下次读取又回到 null 看不出区别；0 则是合法位置别误伤
    const persisted = JSON.parse(
      readData(DataName.aiPrefs) ?? "{}"
    ) as Record<string, unknown>;
    expect(persisted.reopenTabTop).toBeNull();
  });

  it("0 是合法位置（贴窗口顶），不当成无效值", () => {
    saveReopenTabTop(0);
    expect(loadReopenTabTop()).toBe(0);
  });

  it("非法值退回 null：负数、NaN、非数字", () => {
    const put = (value: unknown) => {
      // 绕过类型直接写脏数据，模拟文件被外部改坏
      writeData(
        DataName.aiPrefs,
        JSON.stringify({ reopenTabTop: value })
      );
      expect(loadReopenTabTop()).toBeNull();
    };
    put(-10);
    put(Number.NaN);
    put(Number.POSITIVE_INFINITY);
    put("240");
    put({});
    put([]);
  });
});
