/**
 * 主机档案（host_notes）纯逻辑测试：hostKey 口径、保存/读取 roundtrip、
 * 清空即删、上下文摘要截断。
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
  hostKeyOfSession,
  hostNoteSummary,
  loadHostNote,
  saveHostNote
} from "@/terminal/lib/ai/hostNotes";

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

beforeEach(() => {
  store.clear();
  clearData(DataName.hostNotes);
});

describe("hostKeyOfSession", () => {
  it("远程会话拼 user@host:port", () => {
    expect(
      hostKeyOfSession({
        username: "root",
        host: "10.0.0.1",
        port: 22
      })
    ).toBe("root@10.0.0.1:22");
  });

  it("本地会话固定 local，无会话为空串", () => {
    expect(
      hostKeyOfSession({
        kind: "local",
        host: ""
      })
    ).toBe("local");
    expect(hostKeyOfSession(null)).toBe("");
  });
});

describe("load / save roundtrip", () => {
  it("保存后读回原文，多主机互不串", () => {
    saveHostNote(
      "root@10.0.0.1:22",
      "## 角色\n生产"
    );
    saveHostNote("local", "本机是开发机");
    expect(loadHostNote("root@10.0.0.1:22")).toBe(
      "## 角色\n生产"
    );
    expect(loadHostNote("local")).toBe(
      "本机是开发机"
    );
    expect(loadHostNote("root@10.0.0.2:22")).toBe(
      ""
    );
  });

  it("清空保存 = 删除档案", () => {
    saveHostNote("root@10.0.0.1:22", "some");
    saveHostNote("root@10.0.0.1:22", "   ");
    expect(loadHostNote("root@10.0.0.1:22")).toBe(
      ""
    );
  });
});

describe("hostNoteSummary", () => {
  it("没档案返回空串（上下文里就不注入这段）", () => {
    expect(hostNoteSummary("nobody")).toBe("");
  });

  it("超过 800 字符截断并提示", () => {
    const long = "x".repeat(900);
    saveHostNote("h1", long);
    const summary = hostNoteSummary("h1");
    expect(summary.length).toBeLessThan(
      long.length
    );
    expect(summary).toContain("已截断");
  });

  it("800 以内原样返回", () => {
    const note = "短档案";
    saveHostNote("h2", note);
    expect(hostNoteSummary("h2")).toBe(note);
  });
});
