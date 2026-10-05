import { describe, expect, it } from "vitest";
import {
  repairToolMessages,
  type ProtocolMessage
} from "../src/terminal/lib/aiChat";

const assistantCalls = (
  ...ids: string[]
): ProtocolMessage => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map(id => ({
    id,
    type: "function" as const,
    function: {
      name: "run_command",
      arguments: "{}"
    }
  }))
});

const tool = (id: string): ProtocolMessage => ({
  role: "tool",
  content: "ok",
  tool_call_id: id
});

describe("repairToolMessages", () => {
  it("完整流原样通过", () => {
    const msgs = [
      { role: "user", content: "hi" },
      assistantCalls("a"),
      tool("a")
    ];
    expect(repairToolMessages(msgs)).toEqual(
      msgs
    );
  });

  it("缺 tool 回复的补占位", () => {
    const out = repairToolMessages([
      { role: "user", content: "hi" },
      assistantCalls("a", "b"),
      tool("b")
    ]);
    expect(out).toHaveLength(4);
    expect(out[2]).toMatchObject({
      role: "tool",
      tool_call_id: "a"
    });
  });

  it("挂起期间用户发新消息：user 前补齐欠账", () => {
    const out = repairToolMessages([
      assistantCalls("a", "b"),
      tool("b"),
      { role: "user", content: "继续" }
    ]);
    expect(out).toHaveLength(4);
    expect(out[2].tool_call_id).toBe("a");
    expect(out[3]).toMatchObject({
      role: "user",
      content: "继续"
    });
  });

  it("流末尾缺失的也在末尾补", () => {
    const out = repairToolMessages([
      assistantCalls("a")
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].tool_call_id).toBe("a");
  });

  it("孤儿 tool 消息丢弃", () => {
    const out = repairToolMessages([
      { role: "user", content: "hi" },
      tool("ghost")
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("连续两轮 tool_calls 都补齐", () => {
    const out = repairToolMessages([
      assistantCalls("a"),
      tool("a"),
      assistantCalls("b", "c"),
      tool("c")
    ]);
    expect(out).toHaveLength(5);
    expect(out[3].tool_call_id).toBe("b");
  });
});
