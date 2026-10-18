import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// i18n 用 useSyncExternalStore，SSR 下缺 getServerSnapshot 会抛
// （同 colorPickerRender.test.ts 的处理）
vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import {
  parseAskToolArguments,
  ASK_QUESTION_LIMIT,
  ASK_OPTION_LIMIT
} from "@/terminal/lib/ai/tools";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import type { AiQuestionCall } from "@/terminal/lib/ai/aiChat";

/** 构造一组反问（题数可控）。 */
function makeAsk(
  overrides: Partial<AiQuestionCall> = {}
): AiQuestionCall {
  return {
    id: "call_ask_1",
    title: "清理日志前确认",
    questions: [
      {
        id: "q1",
        prompt: "要清理哪些目录？",
        options: ["/var/log", "/tmp"]
      },
      {
        id: "q2",
        prompt: "归档文件放哪？",
        options: ["/backup/logs"]
      }
    ],
    answers: {},
    state: "pending",
    ...overrides
  };
}

describe("ask_questions 参数解析", () => {
  it("完整提问：标题 + 题目（候选项原样保留）", () => {
    const parsed = parseAskToolArguments(
      JSON.stringify({
        title: " 清理日志前确认 ",
        questions: [
          {
            id: "q1",
            prompt: "要清理哪些目录？",
            options: ["/var/log", " /tmp "]
          }
        ]
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("清理日志前确认");
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0]?.options).toEqual(
      ["/var/log", "/tmp"]
    );
  });

  it("题目 id 重复 → 整份作废（作答按 id 归键，重复会串答案）", () => {
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: [
            {
              id: "q1",
              prompt: "a",
              options: ["x"]
            },
            {
              id: "q1",
              prompt: "b",
              options: ["y"]
            }
          ]
        })
      )
    ).toBeNull();
  });

  it("任何一题缺 id / prompt / options → null（不静默跳过少一题）", () => {
    const base = {
      title: "t",
      questions: [
        { id: "q1", prompt: "a", options: ["x"] }
      ]
    };
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: [
            { prompt: "a", options: ["x"] }
          ]
        })
      )
    ).toBeNull();
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: [
            { id: "q1", options: ["x"] }
          ]
        })
      )
    ).toBeNull();
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: [
            { id: "q1", prompt: "a", options: [] }
          ]
        })
      )
    ).toBeNull();
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: [
            {
              id: "q1",
              prompt: "a",
              options: [""]
            }
          ]
        })
      )
    ).toBeNull();
    expect(base).toBeTruthy(); // 基准用例本身合法
  });

  it(`题数封顶 ${ASK_QUESTION_LIMIT}、选项封顶 ${ASK_OPTION_LIMIT}`, () => {
    const questions = Array.from(
      { length: ASK_QUESTION_LIMIT + 2 },
      (_, i) => ({
        id: `q${i}`,
        prompt: `问题 ${i}`,
        options: Array.from(
          { length: ASK_OPTION_LIMIT + 3 },
          (_, j) => `选项 ${j}`
        )
      })
    );
    const parsed = parseAskToolArguments(
      JSON.stringify({ title: "t", questions })
    );
    expect(parsed?.questions).toHaveLength(
      ASK_QUESTION_LIMIT
    );
    expect(
      parsed?.questions[0]?.options
    ).toHaveLength(ASK_OPTION_LIMIT);
  });

  it("questions 不是数组 / 空数组 / 非法 JSON → null", () => {
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: "x"
        })
      )
    ).toBeNull();
    expect(
      parseAskToolArguments(
        JSON.stringify({
          title: "t",
          questions: []
        })
      )
    ).toBeNull();
    expect(
      parseAskToolArguments("{oops")
    ).toBeNull();
  });

  it("工具名泄漏时替换为「反问确认」", () => {
    const text = sanitizeToolNames(
      "我将通过 ask_questions 提问"
    );
    expect(text).toContain("反问确认");
    expect(text).not.toContain("ask_questions");
  });
});

describe("反问卡渲染（aicss Approval Card questions 变体适配）", () => {
  it("待作答：标题 / 题目 / 字母选项 / 「其他」空输入项 / 继续按钮", async () => {
    const { AiQuestionCard } =
      await import("@/terminal/components/ai/AiQuestionCard");
    const html = renderToStaticMarkup(
      createElement(AiQuestionCard, {
        call: makeAsk(),
        busy: false,
        onAnswer: () => {},
        onSkip: () => {}
      })
    );
    // 题目与候选项
    expect(html).toContain("清理日志前确认");
    expect(html).toContain("要清理哪些目录？");
    expect(html).toContain("/var/log");
    // 字母键：第一题两个选项 → A / B，「其他」顺延到 C
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain(">C<");
    // 「其他」是一个空的 text input（用户自己填）
    expect(html).toContain('type="text"');
    expect(html).toContain('data-other="true"');
    // 操作按钮
    expect(html).toContain(
      "ai.question.continue"
    );
    expect(html).toContain("ai.question.skip");
    // 未答完时继续按钮禁用（disabled 在按钮开标签上，文案是文本节点）
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>ai\.question\.continue</
    );
  });

  it("第二题默认不在激活态（逐题轮播，非当前题 aria-hidden）", async () => {
    const { AiQuestionCard } =
      await import("@/terminal/components/ai/AiQuestionCard");
    const html = renderToStaticMarkup(
      createElement(AiQuestionCard, {
        call: makeAsk(),
        busy: false,
        onAnswer: () => {},
        onSkip: () => {}
      })
    );
    expect(html).toContain('data-active="true"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("已作答：显示题目与答案汇总，没有交互按钮", async () => {
    const { AiQuestionCard } =
      await import("@/terminal/components/ai/AiQuestionCard");
    const html = renderToStaticMarkup(
      createElement(AiQuestionCard, {
        call: makeAsk({
          state: "answered",
          answers: {
            q1: "/var/log",
            q2: "其他：/data/archive"
          }
        }),
        busy: false,
        onAnswer: () => {},
        onSkip: () => {}
      })
    );
    expect(html).toContain(
      "ai.question.answered"
    );
    expect(html).toContain("/var/log");
    expect(html).toContain("其他：/data/archive");
    expect(html).not.toContain(
      "ai.question.continue"
    );
  });

  it("已跳过：标注已跳过，未答的题目显示未回答", async () => {
    const { AiQuestionCard } =
      await import("@/terminal/components/ai/AiQuestionCard");
    const html = renderToStaticMarkup(
      createElement(AiQuestionCard, {
        call: makeAsk({ state: "cancelled" }),
        busy: false,
        onAnswer: () => {},
        onSkip: () => {}
      })
    );
    expect(html).toContain(
      "ai.question.cancelled"
    );
    expect(html).toContain(
      "ai.question.unanswered"
    );
  });
});

describe("反问的接线（防静默失效）", () => {
  it("工具 schema 在三种 API 格式里都注了", async () => {
    const src = (
      await import("@/terminal/lib/ai/adapters.ts?raw")
    ).default;
    const uses =
      src.match(/TOOL_ASK_QUESTIONS/g) ?? [];
    expect(uses.length).toBe(4);
    expect(src).toContain(
      "ASK_QUESTIONS_PARAMETERS"
    );
  });

  it("引擎认这个工具并挂起等作答", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(src).toContain("TOOL_ASK_QUESTIONS");
    expect(src).toContain(
      "parseAskToolArguments"
    );
    expect(src).toContain("answerQuestions");
    expect(src).toContain("cancelQuestions");
    // 反问卡不进 confirm / skip（有专属作答入口）
    expect(src).toMatch(
      /held\.kind === "plan" \|\|\s*held\.kind === "question"/
    );
  });

  it("消息流渲染反问卡", async () => {
    const src = (
      await import("@/terminal/components/ai/AiMessageList.tsx?raw")
    ).default;
    expect(src).toContain("AiQuestionCard");
    expect(src).toContain('kind === "question"');
    expect(src).toContain("onAnswerQuestions");
  });

  it("系统提示词交代了反问的纪律（缺信息才问、答完再继续）", async () => {
    const { SYSTEM_PROMPT } =
      await import("@/terminal/lib/ai/promptContext");
    expect(SYSTEM_PROMPT).toContain("反问工具");
    expect(SYSTEM_PROMPT).toContain("停下等待");
    expect(SYSTEM_PROMPT).toContain(
      "ask_questions"
    );
  });

  it("停止时放弃待回答的提问（不留死卡）", async () => {
    const src = (
      await import("@/terminal/lib/ai/aiChat.ts?raw")
    ).default;
    expect(src).toContain(
      "[用户停止了本轮，提问未回答]"
    );
  });
});
