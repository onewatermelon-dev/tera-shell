import { describe, expect, it } from "vitest";
import {
  anthropicAdapter,
  parseToolArguments,
  responsesAdapter,
  trimToolOutput
} from "@/terminal/lib/aiChat";
import { parseSysInfo } from "@/terminal/lib/sysInfo";

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

  it("用户消息带图片时转成 text + base64 image 块", () => {
    const body = anthropicAdapter.buildBody(
      option,
      [
        {
          role: "user",
          content: "看这张图",
          images: ["data:image/jpeg;base64,QUJD"]
        }
      ]
    ) as {
      messages: [
        {
          content: Array<{
            type: string;
            source?: {
              type: string;
              media_type: string;
              data: string;
            };
          }>;
        }
      ];
    };
    const blocks = body.messages[0].content;
    expect(blocks.map(b => b.type)).toEqual([
      "text",
      "image"
    ]);
    expect(blocks[1]?.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "QUJD"
    });
  });
});

describe("responses 适配器", () => {
  it("用户消息带图片时转成 input_text + input_image", () => {
    const option = {
      provider: {
        baseUrl: "https://api.example.com"
      },
      model: {
        name: "gpt-x",
        maxOutputTokens: "4096"
      }
    } as never;
    const body = responsesAdapter.buildBody(
      option,
      [
        {
          role: "user",
          content: "图",
          images: ["data:image/png;base64,QUJD"]
        }
      ]
    ) as {
      input: [
        {
          content: Array<{
            type: string;
            image_url?: string;
          }>;
        }
      ];
    };
    const parts = body.input[0].content;
    expect(parts.map(p => p.type)).toEqual([
      "input_text",
      "input_image"
    ]);
    expect(parts[1]?.image_url).toBe(
      "data:image/png;base64,QUJD"
    );
  });

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

describe("parseSysInfo", () => {
  const stdout = [
    "host1",
    "/root",
    "---",
    "===OS===",
    "Ubuntu 24.04.3 LTS",
    "6.8.0-90-generic",
    "x86_64",
    "cloud-1",
    "===CPU===",
    "Architecture: x86_64",
    "Model name: Intel(R) Xeon(R) CPU",
    "CPU(s): 2",
    "L1d cache: 64 KiB (2 instances)",
    "L3 cache: 16 MiB (1 instance)",
    "BogoMIPS: 4988.44",
    "===STAT===",
    "cpu 100 0 50 800 10 0 0 0 0 0",
    "cpu 101 0 51 846 11 0 0 0 0 0",
    "===MEM===",
    "MemTotal: 961536 kB",
    "MemFree: 158464 kB",
    "MemAvailable: 551680 kB",
    "Buffers: 128 kB",
    "Cached: 561920 kB",
    "Shmem: 1280 kB",
    "SwapTotal: 0 kB",
    "SwapFree: 0 kB",
    "===UPTIME===",
    "6652800.00 100.00",
    "===LOAD===",
    "0.00 0.00 0.00",
    "===NET===",
    "Inter-| Receive | Transmit",
    "face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed",
    " lo: 1700000000 1 0 0 0 0 0 0 1700000000 1 0 0 0 0 0 0",
    "ens3: 89800000000 1 0 0 0 0 0 0 68700000000 1 0 0 0 0 0 0",
    " lo: 1700000000 1 0 0 0 0 0 0 1700000000 1 0 0 0 0 0 0",
    "ens3: 89801000000 1 0 0 0 0 0 0 68700500000 1 0 0 0 0 0 0",
    "===DISK===",
    "Filesystem Size Used Avail Use% Mounted on",
    "tmpfs 97M 1.1M 96M 2% /run",
    "/dev/sda1 48G 4.2G 44G 9% /",
    "tmpfs 481M 0 481M 0% /dev/shm"
  ].join("\n");

  it("解析各分节为结构化数据", () => {
    const info = parseSysInfo(stdout);
    expect(info.os).toBe("Ubuntu 24.04.3 LTS");
    expect(info.hostname).toBe("cloud-1");
    expect(info.cpu.name).toBe(
      "Intel(R) Xeon(R) CPU"
    );
    expect(info.cpu.cores).toBe("2");
    expect(info.cpu.caches).toEqual([
      "L1d: 64 KiB (2 instances)",
      "L3: 16 MiB (1 instance)"
    ]);
    // 两次采样差：user=1 system=1 idle=46 iowait=1，total=49
    expect(info.cpuTotal).toBeCloseTo(
      100 - (46 / 49) * 100 - (1 / 49) * 100,
      1
    );
    expect(info.mem.total).toBe(961536 * 1024);
    expect(info.mem.used).toBe(
      (961536 - 551680) * 1024
    );
    expect(info.uptimeSec).toBe(6652800);
    const ens3 = info.net.find(
      n => n.name === "ens3"
    );
    expect(ens3?.rxBps).toBe(1000000);
    expect(ens3?.txBps).toBe(500000);
    expect(info.disks).toHaveLength(3);
    expect(info.rootDisk).toEqual({
      used: 4.2 * 1024 ** 3,
      pct: 9
    });
  });

  it("缺分节时不抛错、给空值", () => {
    const info = parseSysInfo("===OS===\nfoo");
    expect(info.os).toBe("foo");
    expect(info.net).toEqual([]);
    expect(info.rootDisk).toBeNull();
    expect(info.cpuTotal).toBeCloseTo(0, 5);
  });
});
