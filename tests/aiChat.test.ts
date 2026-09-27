import { describe, expect, it } from "vitest";
import {
  anthropicAdapter,
  parseToolArguments,
  responsesAdapter,
  trimToolOutput
} from "@/terminal/lib/aiChat";

describe("parseToolArguments", () => {
  it("解析模型的工具调用参数", () => {
    expect(
      parseToolArguments(
        '{"command":"pwd","question":"看目录","is_read_only":true}'
      )
    ).toEqual({
      command: "pwd",
      question: "看目录",
      isReadOnly: true
    });
  });

  it("拒绝空命令与坏 JSON", () => {
    expect(
      parseToolArguments('{"command":"  "}')
    ).toBeNull();
    expect(
      parseToolArguments("not json")
    ).toBeNull();
  });
});

describe("trimToolOutput", () => {
  it("短输出原样返回", () => {
    expect(trimToolOutput("ok")).toBe("ok");
  });

  it("超长输出保留尾部并按 WisdomSSH 格式注明", () => {
    const out = trimToolOutput("x".repeat(10500));
    expect(out).toContain(
      "[内容太长，已截断。原始长度: 10500 字符，显示最后 10000 字符]"
    );
    expect(out.length).toBeLessThan(10200);
  });
});

describe("anthropic 适配器", () => {
  const provider = {
    id: "p1",
    name: "测试",
    baseUrl: "https://api.example.com",
    apiFormat: "anthropic" as const,
    apiKey: "k",
    enabled: true,
    models: []
  };
  const option = {
    providerId: "p1",
    modelId: "m1",
    label: "测试 / m",
    provider,
    model: {
      id: "m1",
      name: "claude-x",
      enabled: true,
      smartConfig: false,
      contextWindow: "",
      maxOutputTokens: "4096",
      inputTypes: ["text"],
      capabilities: [],
      reasoningLevels: [],
      reasoningMapping: ""
    }
  };

  it("system 拆到顶层，连续 tool 结果合并进同一条 user 消息", () => {
    const body = anthropicAdapter.buildBody(
      option,
      [
        { role: "system", content: "sys" },
        { role: "user", content: "看进程" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: {
                name: "run_command",
                arguments: '{"command":"ps"}'
              }
            }
          ]
        },
        {
          role: "tool",
          content: "out1",
          tool_call_id: "t1"
        },
        {
          role: "tool",
          content: "out2",
          tool_call_id: "t2"
        }
      ]
    ) as { system: string; messages: unknown[] };
    expect(body.system).toBe("sys");
    expect(body.messages).toHaveLength(3);
    const last = body.messages[2] as {
      role: string;
      content: Array<{ type: string }>;
    };
    expect(last.role).toBe("user");
    expect(last.content.map(b => b.type)).toEqual(
      ["tool_result", "tool_result"]
    );
  });

  it("解析 tool_use 块为 OpenAI 形态的 tool_calls", () => {
    const message = anthropicAdapter.parse(
      '{"content":[{"type":"tool_use","id":"t1","name":"run_command","input":{"command":"ls"}}]}'
    );
    expect(message.role).toBe("assistant");
    expect(
      message.tool_calls?.[0]?.function.name
    ).toBe("run_command");
    expect(message.tool_calls?.[0]?.id).toBe(
      "t1"
    );
  });
});

describe("responses 适配器", () => {
  it("解析 function_call 项为 tool_calls", () => {
    const message = responsesAdapter.parse(
      '{"output":[{"type":"function_call","call_id":"c1","name":"run_command","arguments":"{\\"command\\":\\"ls\\"}"}]}'
    );
    expect(
      message.tool_calls?.[0]?.function.name
    ).toBe("run_command");
    expect(message.tool_calls?.[0]?.id).toBe(
      "c1"
    );
  });
});
