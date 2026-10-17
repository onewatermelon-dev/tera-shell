import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// i18n 用 useSyncExternalStore，SSR 下缺 getServerSnapshot 会抛
// （同 colorPickerRender.test.ts 的处理）
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import {
  parsePlanToolArguments,
  planStepAutoRuns,
  PLAN_STEP_LIMIT
} from "@/terminal/lib/ai/tools";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import { normalizeRestoredPlan } from "@/terminal/lib/ai/useAiHistory";
import type { AiPlanCall } from "@/terminal/lib/ai/aiChat";

/** 构造一份计划调用（步骤数可控）。 */
function makePlan(
  overrides: Partial<AiPlanCall> = {}
): AiPlanCall {
  return {
    id: "call_plan_1",
    title: "部署 nginx 配置",
    summary: "备份原配置，写入新配置并重载服务",
    steps: [
      {
        id: "call_plan_1#0",
        title: "备份现有配置",
        command:
          "cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak",
        isReadOnly: false,
        state: "pending"
      },
      {
        id: "call_plan_1#1",
        title: "写入新配置",
        command: "tee /etc/nginx/nginx.conf",
        isReadOnly: false,
        state: "pending"
      }
    ],
    state: "pending",
    ...overrides
  };
}

describe("propose_plan 参数解析", () => {
  it("完整计划：标题 / 摘要 / 步骤（detail 可选保留）", () => {
    const parsed = parsePlanToolArguments(
      JSON.stringify({
        title: " 部署 nginx ",
        summary: "备份并重载",
        steps: [
          {
            title: "备份",
            detail: "保留回滚副本",
            command: "cp a b",
            is_read_only: false
          },
          {
            title: "重载",
            command: "nginx -s reload",
            is_read_only: true
          }
        ]
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("部署 nginx");
    expect(parsed?.steps).toHaveLength(2);
    expect(parsed?.steps[0]?.detail).toBe(
      "保留回滚副本"
    );
    expect(
      parsed?.steps[1]?.detail
    ).toBeUndefined();
  });

  it("is_read_only 缺省按读写算（保守：标错只读只是白等一次确认）", () => {
    const parsed = parsePlanToolArguments(
      JSON.stringify({
        title: "t",
        summary: "s",
        steps: [{ title: "x", command: "ls" }]
      })
    );
    expect(parsed?.steps[0]?.isReadOnly).toBe(
      false
    );
  });

  it("缺标题 / steps 不是数组 / 空步骤 → null", () => {
    const base = {
      title: "t",
      summary: "s",
      steps: [{ title: "x", command: "ls" }]
    };
    expect(
      parsePlanToolArguments(
        JSON.stringify({ ...base, title: "  " })
      )
    ).toBeNull();
    expect(
      parsePlanToolArguments(
        JSON.stringify({ ...base, steps: "nope" })
      )
    ).toBeNull();
    expect(
      parsePlanToolArguments(
        JSON.stringify({ ...base, steps: [] })
      )
    ).toBeNull();
  });

  it("任何一步缺标题或命令 → 整份作废（不静默跳过少一步的计划）", () => {
    expect(
      parsePlanToolArguments(
        JSON.stringify({
          title: "t",
          summary: "s",
          steps: [
            { title: "ok", command: "ls" },
            {
              title: "坏步骤",
              is_read_only: true
            }
          ]
        })
      )
    ).toBeNull();
    expect(
      parsePlanToolArguments(
        JSON.stringify({
          title: "t",
          summary: "s",
          steps: [
            { title: "ok", command: "ls" },
            { command: "ls", is_read_only: true }
          ]
        })
      )
    ).toBeNull();
  });

  it(`超过 ${PLAN_STEP_LIMIT} 步 → null（计划卡要全量展示）`, () => {
    const steps = Array.from(
      { length: PLAN_STEP_LIMIT + 1 },
      (_, i) => ({
        title: `步骤 ${i}`,
        command: "ls",
        is_read_only: true
      })
    );
    expect(
      parsePlanToolArguments(
        JSON.stringify({
          title: "t",
          summary: "s",
          steps
        })
      )
    ).toBeNull();
  });

  it("非法 JSON → null", () => {
    expect(
      parsePlanToolArguments("{oops")
    ).toBeNull();
  });
});

describe("计划步骤的自动执行判定（与单条命令同一套规则）", () => {
  const options = {
    autoExecute: true,
    autoApply: false,
    blacklist: [] as string[]
  };

  it("只读步骤看自动执行开关", () => {
    expect(
      planStepAutoRuns(
        { command: "ls", isReadOnly: true },
        options
      )
    ).toBe(true);
    expect(
      planStepAutoRuns(
        { command: "ls", isReadOnly: true },
        { ...options, autoExecute: false }
      )
    ).toBe(false);
  });

  it("读写步骤看自动应用开关", () => {
    expect(
      planStepAutoRuns(
        { command: "rm -f x", isReadOnly: false },
        options
      )
    ).toBe(false);
    expect(
      planStepAutoRuns(
        { command: "rm -f x", isReadOnly: false },
        { ...options, autoApply: true }
      )
    ).toBe(true);
  });

  it("黑名单永不自动执行（即使开关全开、模型标了只读）", () => {
    expect(
      planStepAutoRuns(
        {
          command: "shutdown -h now",
          isReadOnly: true
        },
        {
          autoExecute: true,
          autoApply: true,
          blacklist: ["shutdown"]
        }
      )
    ).toBe(false);
  });
});

describe("计划工具名的用户侧呈现", () => {
  it("propose_plan 泄漏时替换为「执行计划」", () => {
    const text = sanitizeToolNames(
      "我将通过 propose_plan 提出计划"
    );
    expect(text).toContain("执行计划");
    expect(text).not.toContain("propose_plan");
  });

  it("代码块内不动（用户问 schema 时工具名是正确答案）", () => {
    const src =
      '```json\n{ "name": "propose_plan" }\n```';
    expect(sanitizeToolNames(src)).toContain(
      "propose_plan"
    );
  });
});

describe("历史恢复时计划卡归一化", () => {
  it("待批准 / 执行中的计划 → 已中止，未结束步骤标已跳过", () => {
    for (const state of [
      "pending" as const,
      "running" as const
    ]) {
      const plan = makePlan({
        state,
        steps: [
          {
            ...makePlan().steps[0]!,
            state: "done",
            exitCode: 0
          },
          makePlan().steps[1]!
        ]
      });
      const restored =
        normalizeRestoredPlan(plan);
      expect(restored.state).toBe("aborted");
      // 已完成的步骤原样保留（结果还在）
      expect(restored.steps[0]?.state).toBe(
        "done"
      );
      expect(restored.steps[0]?.exitCode).toBe(0);
      // 未完成的标跳过 + 原因
      expect(restored.steps[1]?.state).toBe(
        "skipped"
      );
      expect(restored.steps[1]?.error).toBe(
        "会话中断，未执行"
      );
    }
  });

  it("已是终态的计划原样返回（同一引用，不复制）", () => {
    for (const state of [
      "done" as const,
      "cancelled" as const,
      "aborted" as const
    ]) {
      const plan = makePlan({ state });
      expect(normalizeRestoredPlan(plan)).toBe(
        plan
      );
    }
  });
});

describe("计划卡渲染（aicss Approval Card plan 变体适配）", () => {
  // ⚠️ i18n 被 mock 成「返回键本身」，界面文案断言一律用键名；
  // 模型给的内容（标题 / 摘要 / 命令）是数据，照常断言原文
  it("待批准：标题 / 摘要 / 步骤 / 批准与取消按钮都在", async () => {
    const { AiPlanCard } =
      await import("@/terminal/components/ai/AiPlanCard");
    const html = renderToStaticMarkup(
      createElement(AiPlanCard, {
        call: makePlan(),
        awaitingConfirm: true,
        pendingStepId: null,
        busy: false,
        onApprove: () => {},
        onReject: () => {},
        onConfirmStep: () => {},
        onSkipStep: () => {}
      })
    );
    expect(html).toContain("ai.plan.title");
    expect(html).toContain("部署 nginx 配置");
    expect(html).toContain("备份原配置");
    expect(html).toContain("备份现有配置");
    expect(html).toContain("ai.plan.approve");
    expect(html).toContain("ai.plan.reject");
    // 步骤命令也要露出来（用户批准前要看每步到底跑什么）
    expect(html).toContain("nginx.conf.bak");
  });

  it("执行中：显示进度、没有批准/取消按钮", async () => {
    const { AiPlanCard } =
      await import("@/terminal/components/ai/AiPlanCard");
    const html = renderToStaticMarkup(
      createElement(AiPlanCard, {
        call: makePlan({ state: "running" }),
        awaitingConfirm: false,
        pendingStepId: null,
        busy: true,
        onApprove: () => {},
        onReject: () => {},
        onConfirmStep: () => {},
        onSkipStep: () => {}
      })
    );
    expect(html).toContain("ai.plan.running");
    expect(html).not.toContain("ai.plan.approve");
  });

  it("单步待确认：卡内直接放执行 / 跳过", async () => {
    const { AiPlanCard } =
      await import("@/terminal/components/ai/AiPlanCard");
    const html = renderToStaticMarkup(
      createElement(AiPlanCard, {
        call: makePlan({ state: "running" }),
        awaitingConfirm: false,
        pendingStepId: "call_plan_1#0",
        busy: true,
        onApprove: () => {},
        onReject: () => {},
        onConfirmStep: () => {},
        onSkipStep: () => {}
      })
    );
    expect(html).toContain("ai.plan.stepExecute");
    expect(html).toContain("ai.plan.stepSkip");
    expect(html).toContain("ai.card.waiting");
  });

  it("超过预览步数折成「还有 N 步」，点开才渲染", async () => {
    const { AiPlanCard } =
      await import("@/terminal/components/ai/AiPlanCard");
    const many = makePlan({
      steps: Array.from(
        { length: 5 },
        (_, i) => ({
          id: `call_plan_1#${i}`,
          title: `步骤 ${i}`,
          command: "ls",
          isReadOnly: true,
          state: "pending" as const
        })
      )
    });
    const html = renderToStaticMarkup(
      createElement(AiPlanCard, {
        call: many,
        awaitingConfirm: true,
        pendingStepId: null,
        busy: false,
        onApprove: () => {},
        onReject: () => {},
        onConfirmStep: () => {},
        onSkipStep: () => {}
      })
    );
    expect(html).toContain("ai.plan.more");
    // 图标会变：收起态是三点（aicss todoMoreGlyph 的三个 circle）
    expect(html).toContain('r="1.25"');
    expect(html).toContain(
      'aria-expanded="false"'
    );
    expect(html).toContain("步骤 0");
    expect(html).toContain("步骤 2");
    // 预览外的步骤不渲染
    expect(html).not.toContain("步骤 4");
  });

  it("展开后按钮不消失（2026-10-17「并没有收起态」回归）", async () => {
    const src = (
      await import("@/terminal/components/ai/AiPlanCard.tsx?raw")
    ).default;
    // 剥掉注释再断言：注释里会正当地提到被禁的写法，不剥会误伤
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    // 隐藏步数必须按「全部 - 预览数」算，与展开态无关。
    // 写成按已展示条数算时，展开后 shown=全部、差为 0，
    // 按钮整个消失，用户再也收不回去
    expect(code).toContain(
      "call.steps.length - PREVIEW_STEPS"
    );
    expect(
      code,
      "hiddenCount 又改回按已展示条数算了 —— 展开后按钮会消失"
    ).not.toContain("shown.length");
  });
});

describe("多步计划的接线（防静默失效）", () => {
  it("工具 schema 在三种 API 格式里都注了（漏一处 = 只在部分供应商生效）", async () => {
    const src = (
      await import("@/terminal/lib/ai/adapters.ts?raw")
    ).default;
    // 常量定义 1 次 + openAi / anthropic / responses 各 1 次
    const uses =
      src.match(/TOOL_PROPOSE_PLAN/g) ?? [];
    expect(uses.length).toBe(4);
    // Anthropic 用 input_schema，另两家用 parameters —— 两处关键字都在
    expect(src).toContain(
      "PROPOSE_PLAN_PARAMETERS"
    );
  });

  it("引擎认这个工具并挂起等批准（不是当成普通命令去解析）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(src).toContain("TOOL_PROPOSE_PLAN");
    expect(src).toContain(
      "parsePlanToolArguments"
    );
    expect(src).toContain("approvePlan");
    expect(src).toContain("rejectPlan");
    // 计划步骤的挂起靠 planStep + settle，缺了就是「点了执行没反应」
    expect(src).toContain("planStep: true");
  });

  it("消息流渲染计划卡（新增 entry 变体必须接进 AiMessageList）", async () => {
    const src = (
      await import("@/terminal/components/ai/AiMessageList.tsx?raw")
    ).default;
    expect(src).toContain("AiPlanCard");
    expect(src).toContain('kind === "plan"');
    expect(src).toContain("onApprovePlan");
  });

  it("系统提示词交代了计划的用法与纪律", async () => {
    const { SYSTEM_PROMPT } =
      await import("@/terminal/lib/ai/promptContext");
    // 先提议等批准、严格按步骤执行、单条命令不包装成计划
    expect(SYSTEM_PROMPT).toContain("先提出计划");
    expect(SYSTEM_PROMPT).toContain("停下等待");
    expect(SYSTEM_PROMPT).toContain(
      "propose_plan"
    );
  });

  it("等确认的步骤不预置 running（2026-10-17「一直显示执行中」回归）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    // 只看 approvePlan 段：文件里别处也有 state = "running"
    // （confirm 执行前置步骤 running、计划整体置 running）
    const approveSeg = src.slice(
      src.indexOf(
        "const approvePlan = useCallback"
      ),
      src.indexOf(
        "const rejectPlan = useCallback"
      )
    );
    // running 只能出现在「确定要自动执行」的分支里 —— 即
    // planStepAutoRuns 判定之后。等确认期间保持 pending，
    // 卡片才显示「等待确认」而不是「执行中」
    const runningAt = approveSeg.indexOf(
      'step.state = "running"'
    );
    const autoCheckAt = approveSeg.indexOf(
      "planStepAutoRuns(step"
    );
    expect(runningAt).toBeGreaterThan(-1);
    expect(autoCheckAt).toBeGreaterThan(-1);
    expect(
      runningAt,
      "running 又跑到了自动判定之前 —— 等确认的步骤会显示成执行中"
    ).toBeGreaterThan(autoCheckAt);
  });

  it("confirm / skip 的计划分支在 option 守卫之前（selected 为 null 也不卡死）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    const confirmSeg = src.slice(
      src.indexOf("const confirm = useCallback"),
      src.indexOf("const skip = useCallback")
    );
    const skipSeg = src.slice(
      src.indexOf("const skip = useCallback")
    );
    // 守卫收窄成 `if (!held) return;` + 后面的 `if (!option) return;`，
    // 计划分支必须夹在两者之间
    for (const [name, seg] of [
      ["confirm", confirmSeg],
      ["skip", skipSeg]
    ] as const) {
      const planStepAt = seg.indexOf("planStep");
      const optionGuardAt = seg.indexOf(
        "if (!option) return"
      );
      expect(planStepAt).toBeGreaterThan(-1);
      expect(optionGuardAt).toBeGreaterThan(-1);
      expect(
        planStepAt,
        `${name} 的计划分支又跑到了 option 守卫后面 —— selected 为 null 时点执行没反应，计划卡死`
      ).toBeLessThan(optionGuardAt);
    }
  });

  it("runLoop 唤醒后只清自己的挂起标记（2026-10-17「一直待执行」竞态回归）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    // approvePlan 接手后同步 setPendingCardId(步骤id) 才 await；被唤醒的
    // 旧 runLoop 续跑是微任务、排在那之后。若收尾是无条件
    // setPendingCardId(null)，会把步骤标记擦掉 → 按钮不渲染、
    // 步骤永远「待执行」。必须是条件清：仍指着本次挂起的 call 才清。
    expect(src).toContain("yieldedCallId");
    // prettier 会把三元表达式拆行，占位符之间放 \s*
    expect(src).toMatch(
      /setPendingCardId\(current =>\s*current === yieldedCallId\s*\?\s*null\s*:\s*current\s*\)/
    );
  });

  it("步骤确认后先置 running 再执行（60s 后台命令期间有反馈）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    // confirm 的 planStep 分支里，executeCard 之前要把 step 置 running
    const confirmSeg = src.slice(
      src.indexOf("const confirm = useCallback"),
      src.indexOf("const skip = useCallback")
    );
    const runningAt = confirmSeg.indexOf(
      'held.step.state = "running"'
    );
    const execAt = confirmSeg.indexOf(
      "await executeCard("
    );
    expect(runningAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(-1);
    expect(runningAt).toBeLessThan(execAt);
  });
});

describe("命令执行的停止接线（2026-10-17「点了暂停命令还在跑」回归）", () => {
  it("aiExec 带上 execId 且提供取消入口", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiExec.ts?raw")
    ).default;
    expect(src).toContain("ai_exec_cancel");
    expect(src).toContain(
      "execId: execId ?? null"
    );
  });

  it("cardExec 把 execId 透传给后端", async () => {
    const src = (
      await import("@/terminal/lib/ai/cardExec.ts?raw")
    ).default;
    expect(src).toContain("execId?: string");
    // aiRunCommand 的第 4 个实参
    expect(src).toMatch(/undefined,\s+execId/);
  });

  it("executeCard 登记 exec id，stop 两条分支都取消后台命令", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(src).toContain(
      "runningExecIdRef.current = execId"
    );
    // 计划分支 + 流式分支各一处取消
    const cancels =
      src.match(/cancelAiExec\(/g) ?? [];
    expect(
      cancels.length,
      "cancelAiExec 只有一处 —— 另一条停止路径的后台命令取消不了"
    ).toBe(2);
  });

  it("计划停止时立刻标停当前步骤，且不用迟到结果覆盖", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(src).toContain("planCurrentStepRef");
    expect(src).toContain(
      'running.error = "用户停止了计划"'
    );
    // 循环里的覆盖守卫：已停止就 break，不用迟到的执行结果改状态
    expect(src).toMatch(
      /if \(planAbortRef\.current\) \{[\s\S]*?planCurrentStepRef\.current = null;[\s\S]*?break;/
    );
  });

  it("Rust：取消注册表 + 读循环检查 + 取消命令三件套", async () => {
    const src = (
      await import("../src-tauri/src/ai.rs?raw")
    ).default;
    expect(src).toContain("ai_exec_cancel");
    expect(src).toContain("cancels:");
    // 读循环每轮查取消 + 置位即关通道
    expect(src).toContain(
      "cancel.load(Ordering::Relaxed)"
    );
    expect(src).toContain(
      "let _ = channel.close();"
    );
    // 取消不重试（重连再跑一遍违背用户意图）
    expect(src).toContain(
      "Err(ExecError::Cancelled) => {"
    );
  });
});
