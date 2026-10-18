"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import {
  CheckCircleFilled,
  QuestionCircleOutlined
} from "@ant-design/icons";
import {
  useT,
  type Translator
} from "@/settings/lib/i18n";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import type {
  AiQuestion,
  AiQuestionCall
} from "@/terminal/lib/ai/aiChat";
import styles from "./AiQuestionCard.module.css";

/**
 * 反问卡：模型信息不足时逐题提问，用户点选候选项作答。
 *
 * 外观与交互搬自 @aicss/react 的 ApprovalCard（MIT，源码见
 * node_modules/@aicss/react/src/approval-card/ApprovalCard.tsx）的
 * **questions 变体**，按本项目做了改造：
 * ① 只保留 questions 变体；
 * ② 配色改用项目主题变量（aicss 原版是写死的浅色十六进制）；
 * ③ 追加「跳过」入口 —— aicss 原版只能答不能躲，本项目的反问要能
 *    让模型按默认方案继续；
 * ④ 逐题轮播的高度 / 位移测量走容器 ref 在 effect 里查 DOM
 *    （渲染期不碰 ref.current，react-hooks v6 的硬规则），动画在
 *    prefers-reduced-motion 下整体关闭；
 * ⑤ 步骤徽标用静态等宽数字（aicss 的滚动数字是纯装饰，砍掉换 60 行
 *    动画风险）。
 *
 * 「其他」自由输入项由客户端渲染（模型只给候选项）—— 用户要能自己
 * 填答案，这是需求里点名要的。
 */

/** 选中候选项后自动切到下一题的延迟（毫秒）。 */
const ADVANCE_MS = 320;

/** 逐题轮播 + 作答收集。 */
export function AiQuestionCard({
  call,
  busy,
  onAnswer,
  onSkip
}: {
  call: AiQuestionCall;
  busy: boolean;
  /** 提交作答：题目 id → 答案文本 */
  onAnswer: (
    answers: Record<string, string>
  ) => void;
  /** 跳过整组提问 */
  onSkip: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, string>
  >({});
  const [otherOn, setOtherOn] = useState<
    Record<string, boolean>
  >({});
  const [drafts, setDrafts] = useState<
    Record<string, string>
  >({});
  // 轮播测量：视口高度（动画用）与轨道位移量
  const [viewportH, setViewportH] = useState<
    number | undefined
  >(undefined);
  const [trackY, setTrackY] = useState(0);
  const [animate, setAnimate] = useState(false);
  const advanceTimer = useRef<number | null>(
    null
  );
  /** 轮播轨道容器：测量（子元素 offset）与聚焦（查 input）都经它 */
  const trackRef = useRef<HTMLDivElement>(null);
  const measured = useRef(false);

  const questions = call.questions;
  const safeStep = Math.min(
    step,
    Math.max(questions.length - 1, 0)
  );
  const allAnswered =
    questions.length > 0 &&
    questions.every(question =>
      Boolean(answers[question.id]?.trim())
    );

  // 卸载时清掉未触发的自动切题计时器
  useEffect(
    () => () => {
      if (advanceTimer.current !== null)
        window.clearTimeout(advanceTimer.current);
    },
    []
  );

  const reduceMotion = () =>
    typeof window !== "undefined" &&
    window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

  /** 测量当前题的位置与高度，驱动轮播位移。只在 effect / rAF 里跑。 */
  const syncSlide = (withAnim: boolean) => {
    const item =
      trackRef.current?.children[safeStep];
    if (!item) return;
    setViewportH(
      (item as HTMLElement).offsetHeight + 2
    );
    setTrackY((item as HTMLElement).offsetTop);
    setAnimate(withAnim && !reduceMotion());
  };

  useLayoutEffect(() => {
    const first = !measured.current;
    measured.current = true;
    syncSlide(first);
    // 字体就位后高度可能变，下一帧复测一次
    const raf = requestAnimationFrame(() =>
      syncSlide(first)
    );
    return () => cancelAnimationFrame(raf);
    // safeStep / answers 变化就是重测时机（高度随选项文字而变）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同左
  }, [safeStep, questions, answers]);

  const clearAdvanceTimer = () => {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  const goToStep = (next: number) => {
    clearAdvanceTimer();
    setStep(
      Math.min(
        Math.max(next, 0),
        questions.length - 1
      )
    );
  };

  const submit = () => {
    if (!allAnswered) return;
    onAnswer(answers);
  };

  const selectOption = (
    questionId: string,
    option: string
  ) => {
    setOtherOn(prev => ({
      ...prev,
      [questionId]: false
    }));
    setAnswers(prev => ({
      ...prev,
      [questionId]: option
    }));
    if (safeStep < questions.length - 1) {
      clearAdvanceTimer();
      advanceTimer.current = window.setTimeout(
        () => {
          advanceTimer.current = null;
          setStep(current =>
            Math.min(
              current + 1,
              questions.length - 1
            )
          );
        },
        ADVANCE_MS
      );
    }
  };

  /** 聚焦当前题的「其他」输入框（经轨道容器查，不持有一堆 input ref）。 */
  const focusOtherInput = () => {
    const item =
      trackRef.current?.children[safeStep];
    const input = item?.querySelector(
      '[data-other="true"] input'
    );
    if (input instanceof HTMLInputElement)
      input.focus();
  };

  const selectOther = (questionId: string) => {
    clearAdvanceTimer();
    setOtherOn(prev => ({
      ...prev,
      [questionId]: true
    }));
    const draft =
      drafts[questionId]?.trim() ?? "";
    setAnswers(prev => {
      const next = { ...prev };
      if (draft) next[questionId] = draft;
      else delete next[questionId];
      return next;
    });
    requestAnimationFrame(focusOtherInput);
  };

  const updateCustom = (
    questionId: string,
    text: string
  ) => {
    setDrafts(prev => ({
      ...prev,
      [questionId]: text
    }));
    setOtherOn(prev => ({
      ...prev,
      [questionId]: true
    }));
    setAnswers(prev => {
      const next = { ...prev };
      const trimmed = text.trim();
      if (trimmed) next[questionId] = trimmed;
      else delete next[questionId];
      return next;
    });
  };

  /** 其他项里按回车：提交此题，是最后一题且答满了就整组提交。 */
  const commitCustom = (
    questionId: string,
    raw?: string
  ) => {
    clearAdvanceTimer();
    const text = (
      raw ??
      drafts[questionId] ??
      answers[questionId] ??
      ""
    ).trim();
    if (!text) return;
    const nextAnswers = {
      ...answers,
      [questionId]: text
    };
    setAnswers(nextAnswers);
    if (safeStep < questions.length - 1) {
      setStep(current =>
        Math.min(
          current + 1,
          questions.length - 1
        )
      );
      return;
    }
    if (
      questions.every(question =>
        Boolean(nextAnswers[question.id]?.trim())
      )
    )
      onAnswer(nextAnswers);
  };

  /** 已作答 / 已跳过的收尾展示：题目 + 当时给的答案。 */
  if (call.state !== "pending") {
    return (
      <div
        className={styles.card}
        data-state={call.state}
      >
        <div className={styles.head}>
          <span className={styles.icon}>
            {call.state === "answered" ? (
              <CheckCircleFilled
                className={styles.iconSvg}
              />
            ) : (
              <QuestionCircleOutlined
                className={styles.iconSvg}
              />
            )}
          </span>
          <span className={styles.title}>
            {call.state === "answered"
              ? t("ai.question.answered")
              : t("ai.question.cancelled")}
          </span>
          <span className={styles.count}>
            {call.questions.length}
          </span>
        </div>
        {call.title && (
          <div className={styles.headline}>
            {sanitizeToolNames(call.title)}
          </div>
        )}
        <ul className={styles.summaryList}>
          {call.questions.map(question => (
            <li
              key={question.id}
              className={styles.summaryItem}
            >
              <span
                className={styles.summaryPrompt}
              >
                {sanitizeToolNames(
                  question.prompt
                )}
              </span>
              <span
                className={styles.summaryAnswer}
              >
                {call.answers[
                  question.id
                ]?.trim() ||
                  t("ai.question.unanswered")}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      className={styles.card}
      data-state="pending"
      onKeyDown={event => {
        // 最后一题答满了，在卡片空白处按回车直接提交
        if (event.key !== "Enter") return;
        if (
          safeStep !== questions.length - 1 ||
          !allAnswered
        )
          return;
        const target =
          event.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA"
        )
          return;
        if (
          target.closest(`.${styles.btnGhost}`) ||
          target.closest(`.${styles.btnPrimary}`)
        )
          return;
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.head}>
        <span className={styles.icon}>
          <QuestionCircleOutlined
            className={styles.iconSvg}
          />
        </span>
        <span className={styles.title}>
          {t("ai.question.title")}
        </span>
        <span className={styles.count}>
          {questions.length}
        </span>
      </div>

      {call.title && (
        <div className={styles.headline}>
          {sanitizeToolNames(call.title)}
        </div>
      )}

      {/* 逐题轮播：视口只显示当前题，轨道整体上移 */}
      <div
        className={styles.viewport}
        style={
          viewportH != null
            ? { height: viewportH }
            : undefined
        }
        data-animate={
          animate ? "true" : undefined
        }
        aria-live="polite"
      >
        <div
          ref={trackRef}
          className={styles.track}
          style={{
            transform: `translate3d(0, ${-trackY}px, 0)`
          }}
          data-animate={
            animate ? "true" : undefined
          }
        >
          {questions.map((question, index) => {
            const active = index === safeStep;
            return (
              <div
                key={question.id}
                className={styles.question}
                data-active={
                  active ? "true" : undefined
                }
                data-question={question.id}
                aria-hidden={
                  active ? undefined : true
                }
              >
                <div className={styles.prompt}>
                  {sanitizeToolNames(
                    question.prompt
                  )}
                </div>
                <div
                  className={styles.options}
                  role="radiogroup"
                  aria-label={question.prompt}
                >
                  {question.options.map(
                    (option, optionIndex) => {
                      const selected =
                        answers[question.id] ===
                          option &&
                        !otherOn[question.id];
                      const letter =
                        String.fromCharCode(
                          65 + optionIndex
                        );
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          tabIndex={
                            active ? 0 : -1
                          }
                          className={
                            styles.option
                          }
                          data-selected={
                            selected
                              ? "true"
                              : undefined
                          }
                          onClick={event => {
                            event.preventDefault();
                            if (!active) return;
                            selectOption(
                              question.id,
                              option
                            );
                          }}
                        >
                          <span
                            className={styles.key}
                            aria-hidden="true"
                          >
                            {letter}
                          </span>
                          {option}
                        </button>
                      );
                    }
                  )}
                  {/* 「其他」自由输入项：客户端固定追加在候选项之后，
                      字母顺延；点它聚焦输入框，打字即作答 */}
                  <OtherOption
                    question={question}
                    active={active}
                    answers={answers}
                    otherOn={otherOn}
                    drafts={drafts}
                    styles={styles}
                    t={t}
                    onSelectOther={selectOther}
                    onUpdateCustom={updateCustom}
                    onCommitCustom={commitCustom}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.actions}>
        <div
          className={styles.stepNav}
          aria-label={t("ai.question.progress", {
            current: safeStep + 1,
            total: questions.length
          })}
        >
          <button
            type="button"
            className={styles.stepArrow}
            aria-label={t("ai.question.prev")}
            disabled={safeStep <= 0}
            onClick={() => goToStep(safeStep - 1)}
          >
            <svg
              className={styles.stepArrowIcon}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                d="m18 15-6-6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {/* 步骤徽标：静态等宽数字（aicss 的滚动数字是纯装饰，砍掉） */}
          <span
            className={styles.stepBadge}
            aria-live="polite"
          >
            {safeStep + 1} / {questions.length}
          </span>
          <button
            type="button"
            className={styles.stepArrow}
            aria-label={t("ai.question.next")}
            disabled={
              safeStep >= questions.length - 1
            }
            onClick={() => goToStep(safeStep + 1)}
          >
            <svg
              className={styles.stepArrowIcon}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                d="m6 9 6 6 6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className={styles.actionBtns}>
          <button
            type="button"
            className={styles.btnGhost}
            disabled={busy}
            onClick={onSkip}
          >
            {t("ai.question.skip")}
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={!allAnswered || busy}
            onClick={submit}
          >
            {t("ai.question.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 「其他」自由输入项（aicss 的 data-other 选项）。 */
function OtherOption({
  question,
  active,
  answers,
  otherOn,
  drafts,
  styles,
  t,
  onSelectOther,
  onUpdateCustom,
  onCommitCustom
}: {
  question: AiQuestion;
  active: boolean;
  answers: Record<string, string>;
  otherOn: Record<string, boolean>;
  drafts: Record<string, string>;
  styles: Record<string, string>;
  t: Translator;
  onSelectOther: (questionId: string) => void;
  onUpdateCustom: (
    questionId: string,
    text: string
  ) => void;
  onCommitCustom: (
    questionId: string,
    raw?: string
  ) => void;
}) {
  const currentAnswer = answers[question.id];
  const isCustomAnswer =
    Boolean(currentAnswer) &&
    !question.options.includes(
      currentAnswer ?? ""
    );
  const otherOnNow =
    otherOn[question.id] || isCustomAnswer;
  const letter = String.fromCharCode(
    65 + question.options.length
  );
  const draft =
    drafts[question.id] ??
    (isCustomAnswer ? (currentAnswer ?? "") : "");
  return (
    <div
      role="radio"
      aria-checked={otherOnNow}
      tabIndex={active ? 0 : -1}
      className={styles.option}
      data-selected={
        otherOnNow ? "true" : undefined
      }
      data-other="true"
      onClick={event => {
        event.preventDefault();
        if (!active) return;
        onSelectOther(question.id);
      }}
      onKeyDown={event => {
        if (!active) return;
        if (event.target !== event.currentTarget)
          return;
        if (
          event.key === "Enter" ||
          event.key === " "
        ) {
          event.preventDefault();
          onSelectOther(question.id);
        }
      }}
    >
      <span
        className={styles.key}
        aria-hidden="true"
      >
        {letter}
      </span>
      <input
        className={styles.optionInput}
        type="text"
        value={draft}
        placeholder={t("ai.question.other")}
        tabIndex={active ? 0 : -1}
        aria-label={`${question.prompt} — ${t("ai.question.other")}`}
        onClick={event => {
          event.stopPropagation();
          if (!active) return;
          onSelectOther(question.id);
        }}
        onChange={event => {
          if (!active) return;
          onUpdateCustom(
            question.id,
            event.target.value
          );
        }}
        onKeyDown={event => {
          event.stopPropagation();
          if (!active) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onCommitCustom(
              question.id,
              event.currentTarget.value
            );
          }
        }}
      />
    </div>
  );
}
