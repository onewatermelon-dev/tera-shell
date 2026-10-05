import { expect, test } from "vitest";
import { stepPromptHistory } from "@/terminal/components/aicss/PromptInput";

test("上下键回溯问题并恢复草稿", () => {
  const history = ["第一问", "第二问"];
  const latest = stepPromptHistory(
    history,
    null,
    "未发送草稿",
    "up"
  );
  expect(latest).toEqual({
    index: 1,
    value: "第二问"
  });
  const older = stepPromptHistory(
    history,
    latest.index,
    "未发送草稿",
    "up"
  );
  expect(older).toEqual({
    index: 0,
    value: "第一问"
  });
  expect(
    stepPromptHistory(
      history,
      older.index,
      "未发送草稿",
      "up"
    )
  ).toEqual(older);
  expect(
    stepPromptHistory(
      history,
      older.index,
      "未发送草稿",
      "down"
    )
  ).toEqual(latest);
  expect(
    stepPromptHistory(
      history,
      latest.index,
      "未发送草稿",
      "down"
    )
  ).toEqual({ index: null, value: "未发送草稿" });
});
