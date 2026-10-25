/**
 * Runbook 库纯逻辑测试：占位符提取与替换、CRUD、结果 markdown。
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
  DataName
} from "@/settings/lib/storage";
import {
  applyPlaceholders,
  buildStepsMarkdown,
  deleteRunbook,
  extractPlaceholders,
  loadRunbooks,
  saveRunbook
} from "@/terminal/lib/ai/runbookLibrary";

// localStorage 的 node 内存替身（vitest node 环境没有这个全局）
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

beforeEach(() => {
  store.clear();
  clearData(DataName.runbooks);
});

describe("占位符", () => {
  it("提取去重、按首现排序", () => {
    expect(
      extractPlaceholders([
        "tail {{log_path}}",
        "ssh {{host}} && tail {{log_path}}"
      ])
    ).toEqual(["log_path", "host"]);
  });

  it("替换已填值，未填的保留原样", () => {
    expect(
      applyPlaceholders(
        [
          "curl {{host}}:{{port}}",
          "echo {{host}}"
        ],
        { host: "10.0.0.1" }
      )
    ).toEqual([
      "curl 10.0.0.1:{{port}}",
      "echo 10.0.0.1"
    ]);
  });
});

describe("CRUD", () => {
  it("保存后读回，删除生效", () => {
    saveRunbook({
      id: "r1",
      title: "巡检",
      commands: ["uptime", "df -h /"],
      createdAt: 1
    });
    saveRunbook({
      id: "r2",
      title: "重启",
      commands: ["reboot"],
      createdAt: 2
    });
    expect(loadRunbooks()).toHaveLength(2);
    // 同 id 覆盖
    saveRunbook({
      id: "r1",
      title: "巡检 v2",
      commands: ["uptime"],
      createdAt: 3
    });
    const list = loadRunbooks();
    expect(list).toHaveLength(2);
    expect(
      list.find(item => item.id === "r1")?.title
    ).toBe("巡检 v2");
    deleteRunbook("r2");
    expect(loadRunbooks()).toHaveLength(1);
  });
});

describe("buildStepsMarkdown", () => {
  it("表格含步骤序号、命令与状态", () => {
    const md = buildStepsMarkdown("巡检", [
      {
        command: "uptime",
        ok: true,
        exitCode: 0,
        output: "load 0.1"
      },
      {
        command: "nginx -t",
        ok: false,
        exitCode: 1,
        output: "failed"
      }
    ]);
    expect(md).toContain("巡检");
    expect(md).toContain(
      "| 1 | `uptime` | 成功 |"
    );
    expect(md).toContain("退出码 1");
    // 命令里的竖线要转义，防表格被拆列
    const pipe = buildStepsMarkdown("t", [
      {
        command: "echo a|b",
        ok: true,
        exitCode: 0,
        output: ""
      }
    ]);
    expect(pipe).toContain("echo a\\|b");
  });
});
