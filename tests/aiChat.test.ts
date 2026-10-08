import { describe, expect, it } from "vitest";
import {
  anthropicAdapter,
  dequeueMessage,
  enqueueMessage,
  moveQueued,
  nudgeQueued,
  ownsRound,
  parseToolArguments,
  responsesAdapter,
  trimToolOutput,
  type AiQueuedMessage
} from "@/terminal/lib/aiChat";
import {
  parseNetInfo,
  parseSysInfo
} from "@/terminal/lib/sysInfo";

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

describe("parseNetInfo", () => {
  const stdout = [
    'tcp LISTEN 0 128 127.0.0.1:40475 0.0.0.0:* users:(("sing-box",pid=1916056,fd=20))',
    'tcp LISTEN 0 128 [::]:8885 [::]:* users:(("sing-box",pid=1916056,fd=27))',
    'tcp ESTAB 100 20 [::ffff:10.0.0.5]:8885 [::ffff:1.2.3.4]:52100 users:(("sing-box",pid=1916056,fd=31))',
    'tcp ESTAB 0 0 [::ffff:10.0.0.5]:8885 [::ffff:1.2.3.4]:52101 users:(("sing-box",pid=1916056,fd=32))',
    "udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*"
  ].join("\n");

  it("按协议+本地地址聚合连接数、远端IP数与队列", () => {
    const rows = parseNetInfo(stdout);
    expect(rows).toHaveLength(3);
    const listener = rows.find(
      r => r.port === "8885"
    );
    expect(listener?.connCount).toBe(2);
    expect(listener?.ipCount).toBe(1);
    expect(listener?.recv).toBe(100);
    expect(listener?.send).toBe(20);
    expect(listener?.pid).toBe(1916056);
    expect(listener?.name).toBe("sing-box");
    const udp = rows.find(r => r.port === "68");
    expect(udp?.pid).toBe(0);
    expect(udp?.name).toBe("-");
    expect(udp?.connCount).toBe(0);
  });
});

describe("enqueueMessage", () => {
  it("按 FIFO 追加，id 自动生成且互不相同", () => {
    let queue: AiQueuedMessage[] = [];
    queue = enqueueMessage(queue, {
      text: "第一条",
      images: []
    });
    queue = enqueueMessage(queue, {
      text: "第二条",
      images: []
    });
    expect(queue.map(q => q.text)).toEqual([
      "第一条",
      "第二条"
    ]);
    expect(queue[0]?.id).not.toBe(queue[1]?.id);
  });

  it("同 id 视为编辑：原位替换而不追加", () => {
    let queue = enqueueMessage([], {
      id: "m1",
      text: "原文",
      images: []
    });
    queue = enqueueMessage(queue, {
      id: "m1",
      text: "改过的",
      images: []
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe("改过的");
  });

  it("文字与图片都空的条目不入队", () => {
    const queue = enqueueMessage([], {
      text: "   ",
      images: []
    });
    expect(queue).toHaveLength(0);
  });

  it("只带图（无文字）也允许入队", () => {
    const queue = enqueueMessage([], {
      text: "",
      images: ["data:image/png;base64,AAA"]
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe("");
  });

  it("trim 正文，但保留入参的图片数组不被外部改动影响", () => {
    const images = ["data:image/png;base64,AAA"];
    const queue = enqueueMessage([], {
      text: "  看这里  ",
      images
    });
    expect(queue[0]?.text).toBe("看这里");
    expect(queue[0]?.images).not.toBe(images);
    expect(queue[0]?.images).toEqual(images);
  });
});

describe("dequeueMessage", () => {
  it("移除指定 id，其余保持顺序", () => {
    let queue: AiQueuedMessage[] = [];
    for (const text of ["a", "b", "c"]) {
      queue = enqueueMessage(queue, {
        text,
        images: []
      });
    }
    const mid = queue[1]?.id ?? "";
    const next = dequeueMessage(queue, mid);
    expect(next.map(q => q.text)).toEqual([
      "a",
      "c"
    ]);
  });

  it("id 不存在时内容不变（filter 仍会返回新数组，比内容不比引用）", () => {
    const queue = enqueueMessage([], {
      text: "a",
      images: []
    });
    expect(dequeueMessage(queue, "none")).toEqual(
      queue
    );
  });
});

/** 造一条固定 id 的队列，省得每例都拿 crypto.randomUUID() 再回查。 */
function makeQueue(
  texts: string[]
): AiQueuedMessage[] {
  return texts.map((text, index) => ({
    id: `q${index + 1}`,
    text,
    images: []
  }));
}

describe("moveQueued", () => {
  it("向下拖：落到目标之后（移除自己后目标左移一位）", () => {
    const queue = makeQueue(["a", "b", "c"]);
    // a 拖到 c 上：a 挪出后 b/c 变 [b, c]，插到下标 2 → 落c 后面
    const next = moveQueued(queue, "q1", "q3");
    expect(next.map(q => q.text)).toEqual([
      "b",
      "c",
      "a"
    ]);
  });

  it("向上拖：落到目标之前", () => {
    const queue = makeQueue(["a", "b", "c"]);
    // c 拖到 a 上：插到下标 0
    const next = moveQueued(queue, "q3", "q1");
    expect(next.map(q => q.text)).toEqual([
      "c",
      "a",
      "b"
    ]);
  });

  it("相邻两条互换", () => {
    const queue = makeQueue(["a", "b", "c"]);
    expect(
      moveQueued(queue, "q2", "q1").map(
        q => q.text
      )
    ).toEqual(["b", "a", "c"]);
    expect(
      moveQueued(queue, "q2", "q3").map(
        q => q.text
      )
    ).toEqual(["a", "c", "b"]);
  });

  it("from/to 相同或任一 id 不存在时原样返回", () => {
    const queue = makeQueue(["a", "b"]);
    expect(moveQueued(queue, "q1", "q1")).toEqual(
      queue
    );
    expect(moveQueued(queue, "q1", "zz")).toEqual(
      queue
    );
    expect(moveQueued(queue, "zz", "q1")).toEqual(
      queue
    );
  });

  it("不改动原数组", () => {
    const queue = makeQueue(["a", "b", "c"]);
    const snapshot = queue.map(q => q.text);
    moveQueued(queue, "q1", "q3");
    expect(queue.map(q => q.text)).toEqual(
      snapshot
    );
  });
});

describe("nudgeQueued", () => {
  it("上移/下移一位", () => {
    const queue = makeQueue(["a", "b", "c"]);
    expect(
      nudgeQueued(queue, "q3", -1).map(
        q => q.text
      )
    ).toEqual(["a", "c", "b"]);
    expect(
      nudgeQueued(queue, "q1", 1).map(q => q.text)
    ).toEqual(["b", "a", "c"]);
  });

  it("已在边界或 id 不存在时不动", () => {
    const queue = makeQueue(["a", "b"]);
    expect(nudgeQueued(queue, "q1", -1)).toEqual(
      queue
    );
    expect(nudgeQueued(queue, "q2", 1)).toEqual(
      queue
    );
    expect(nudgeQueued(queue, "zz", -1)).toEqual(
      queue
    );
  });
});

describe("ownsRound（轮次令牌）", () => {
  /** 模拟 hook 里的 roundRef。 */
  let current = 0;

  // 复刻用户实机踩到的那个竞态：
  // 用户在卡片上点「执行」→ confirm 唤醒上一轮挂起的 runLoop →
  // 它被唤醒后立刻 return → 上一轮的 finally 也跑 →
  // setBusy(false) 把 confirm 刚设的 busy=true 冲掉，
  // 症状是「点完卡片按钮，底部发送键退回发送态」。
  // 令牌让旧轮的收尾失效。

  it("同一轮内令牌相等，收尾有效", () => {
    expect(ownsRound(3, 3)).toBe(true);
  });

  it("被新轮次接管后，旧轮收尾必须失效", () => {
    // 第 1 轮 send → 挂起等确认；confirm 领第 2 轮
    const round = (current += 1); // dispatch 领 1
    expect(ownsRound(round, current)).toBe(true);
    current += 1; // confirm 领 2
    expect(ownsRound(round, current)).toBe(false);
  });

  it("停止动作夺取令牌后，在跑的轮次收尾失效", () => {
    const round = (current += 1); // 第 N 轮正在生成
    expect(ownsRound(round, current)).toBe(true);
    current += 1; // stop() 夺取
    expect(ownsRound(round, current)).toBe(false);
  });

  it("切历史 / 新对话后，旧轮收尾失效（否则会写回新话题）", () => {
    const round = (current += 1);
    current += 1; // restore / clear
    expect(ownsRound(round, current)).toBe(false);
  });

  it("令牌严格递增，永不复用", () => {
    // ⚠️ `current` 是 describe 作用域的累加计数器（前面的用例已用过），
    // 所以断言只能验「相对递增」，不能写死[1,2,3,4,5]。
    const base = current;
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      current += 1;
      seen.push(current);
    }
    expect(seen).toEqual([
      base + 1,
      base + 2,
      base + 3,
      base + 4,
      base + 5
    ]);
    // 不该出现重复号（判据用排序去重而非 Set：node 测试环境
    // 没装 @types/node，Set 泛型在部分配置下会报类型错）
    const sorted = [...seen].sort(
      (a, b) => a - b
    );
    const distinct = sorted.filter(
      (value, index) =>
        index === 0 || value !== sorted[index - 1]
    );
    expect(distinct.length).toBe(seen.length);
    // 最早那个号在任何后续时刻都已被判失效
    expect(ownsRound(1, current)).toBe(false);
  });
});
