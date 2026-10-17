/**
 * 多步计划卡：模型提出步骤清单 → 用户批准 → 逐步执行。
 *
 * 外观与交互搬自 @aicss/react 的 ApprovalCard（MIT，源码见
 * node_modules/@aicss/react/src/approval-card/ApprovalCard.tsx）的
 * **plan 变体**，按本项目做了四处改造：
 * ① 只保留 plan 变体（questions / command 用不上）；
 * ② 去掉「30 秒自动批准」倒计时 —— 计划是批量改服务器状态的写操作，
 *    自动批准与项目「破坏性动作必须人确认」的底线冲突；
 * ③ 步骤带执行状态（待执行 / 执行中 / 完成 / 失败 / 跳过），需单独
 *    确认的步骤（读写步骤未开自动应用、或命中黑名单）在卡内直接放
 *    「执行 / 跳过」，不用翻别处；
 * ④ 配色改用项目主题变量（aicss 原版是写死的浅色十六进制 + :global
 *    暗色规则），与终端 / SFTP 卡片同一套视觉语言。
 *
 * 卡片自身不持有面板状态，全部经 props 注入（同 ToolCard / FileCard）。
 */
import { useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
  UnorderedListOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import type {
  AiPlanCall,
  AiPlanStep
} from "@/terminal/lib/ai/aiChat";
import styles from "./AiPlanCard.module.css";

/** 计划卡默认预览的步骤数，超出折成「还有 N 步」（同 aicss 的 planPreviewCount）。 */
const PREVIEW_STEPS = 3;

/** 步骤状态 → 文案键。 */
function stepStateKey(
  step: AiPlanStep,
  awaiting: boolean
):
  | "ai.card.waiting"
  | "ai.plan.stepPending"
  | "ai.plan.stepRunning"
  | "ai.plan.stepDone"
  | "ai.plan.stepFailed"
  | "ai.plan.stepSkipped" {
  if (step.state === "running")
    return "ai.plan.stepRunning";
  if (step.state === "done")
    return "ai.plan.stepDone";
  if (step.state === "failed")
    return "ai.plan.stepFailed";
  if (step.state === "skipped")
    return "ai.plan.stepSkipped";
  // pending：正在等用户确认的这一步显示「等待确认」而不是「待执行」
  return awaiting
    ? "ai.card.waiting"
    : "ai.plan.stepPending";
}

/** 步骤行左侧的状态图标。 */
function StepStatusIcon({
  step,
  awaiting
}: {
  step: AiPlanStep;
  awaiting: boolean;
}) {
  if (step.state === "running")
    return (
      <LoadingOutlined
        className={`${styles.stepIcon} ${styles.stepIconRunning}`}
      />
    );
  if (step.state === "done")
    return (
      <CheckCircleFilled
        className={`${styles.stepIcon} ${styles.stepIconDone}`}
      />
    );
  if (step.state === "failed")
    return (
      <CloseCircleFilled
        className={`${styles.stepIcon} ${styles.stepIconFailed}`}
      />
    );
  if (step.state === "skipped")
    return (
      <MinusCircleOutlined
        className={`${styles.stepIcon} ${styles.stepIconSkipped}`}
      />
    );
  if (awaiting)
    // 等确认：实心圆点，和「待执行」的空心圈区分开
    return (
      <span
        className={`${styles.stepIcon} ${styles.stepIconAwait}`}
      />
    );
  // 待执行：aicss 的虚线圆 TodoDashedIcon
  return (
    <svg
      className={styles.stepIcon}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        pathLength={1}
        strokeDasharray="0.022 0.0613"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 多步计划卡（aicss Approval Card 的 plan 变体）。 */
export function AiPlanCard({
  call,
  awaitingConfirm,
  pendingStepId,
  busy,
  onApprove,
  onReject,
  onConfirmStep,
  onSkipStep
}: {
  call: AiPlanCall;
  /** 整份计划是否在等用户批准（useAiChat.pendingCardId === call.id） */
  awaitingConfirm: boolean;
  /** 当前等确认的计划步骤 id（没有为 null） */
  pendingStepId: string | null;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  /** 执行计划里待确认的单步（后台执行通道） */
  onConfirmStep: (stepId: string) => void;
  onSkipStep: (stepId: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const doneCount = call.steps.filter(
    step => step.state === "done"
  ).length;
  const shown = expanded
    ? call.steps
    : call.steps.slice(0, PREVIEW_STEPS);
  // 超出预览的步数。⚠️ 不能写成 `length - shown.length`：展开后
  // shown 就是全部，差为 0，按钮会整个消失 —— 用户再也收不回去
  // （2026-10-17 用户报「并没有收起态」）。aicss 原版同样用
  // planRest（= 全部减预览）判定，与展开态无关。
  const hiddenCount = Math.max(
    0,
    call.steps.length - PREVIEW_STEPS
  );

  return (
    <div
      className={styles.card}
      data-state={call.state}
    >
      <div className={styles.head}>
        <span className={styles.icon}>
          <UnorderedListOutlined
            className={styles.iconSvg}
          />
        </span>
        <span className={styles.title}>
          {t("ai.plan.title")}
        </span>
        <span className={styles.count}>
          {doneCount}/{call.steps.length}
        </span>
      </div>

      <div className={styles.intro}>
        <div className={styles.headline}>
          {sanitizeToolNames(call.title)}
        </div>
        {call.summary && (
          <div className={styles.summary}>
            {sanitizeToolNames(call.summary)}
          </div>
        )}
      </div>

      <div className={styles.well}>
        <div className={styles.wellHead}>
          <span className={styles.wellTitle}>
            {t("ai.plan.steps")}
          </span>
          <span className={styles.wellCount}>
            {call.steps.length}
          </span>
        </div>
        <ul className={styles.stepList}>
          {shown.map(step => {
            const stepAwaiting =
              pendingStepId === step.id;
            return (
              <li
                key={step.id}
                className={styles.step}
                data-state={step.state}
              >
                <span
                  className={styles.stepIconWrap}
                >
                  <StepStatusIcon
                    step={step}
                    awaiting={stepAwaiting}
                  />
                </span>
                <div className={styles.stepBody}>
                  <div
                    className={styles.stepTitle}
                  >
                    {sanitizeToolNames(
                      step.title
                    )}
                  </div>
                  {step.detail && (
                    <div
                      className={
                        styles.stepDetail
                      }
                    >
                      {sanitizeToolNames(
                        step.detail
                      )}
                    </div>
                  )}
                  <div
                    className={styles.stepCommand}
                  >
                    {step.command}
                  </div>
                  <div
                    className={styles.stepMeta}
                  >
                    <span
                      className={`${styles.stepBadge} ${
                        step.isReadOnly
                          ? styles.stepBadgeRo
                          : styles.stepBadgeRw
                      }`}
                    >
                      {step.isReadOnly
                        ? t("ai.card.ro")
                        : t("ai.card.rw")}
                    </span>
                    <span
                      className={styles.stepState}
                    >
                      {t(
                        stepStateKey(
                          step,
                          stepAwaiting
                        )
                      )}
                    </span>
                    {/* running 时也藏按钮：命令已在后台跑（最长 60s），
                        再点只会空查找；防重复点击靠 confirm 里
                        pendingRef 删除后的空查找。 */}
                    {stepAwaiting &&
                      step.state !==
                        "running" && (
                        <span
                          className={
                            styles.stepActions
                          }
                        >
                          {/* ⚠️ 这两个按钮不跟 busy 禁用：计划执行期间
                              busy 由 approvePlan 持有（挡新消息），步骤
                              确认恰恰要在那个窗口里点。 */}
                          <button
                            type="button"
                            className={
                              styles.stepBtn
                            }
                            onClick={() =>
                              onSkipStep(step.id)
                            }
                          >
                            {t(
                              "ai.plan.stepSkip"
                            )}
                          </button>
                          <button
                            type="button"
                            className={`${styles.stepBtn} ${styles.stepBtnPrimary}`}
                            onClick={() =>
                              onConfirmStep(
                                step.id
                              )
                            }
                          >
                            {t(
                              "ai.plan.stepExecute"
                            )}
                          </button>
                        </span>
                      )}
                  </div>
                  {step.error && (
                    <div
                      className={`${styles.stepError}`}
                    >
                      {step.error}
                    </div>
                  )}
                  {(step.stdout ||
                    step.stderr) && (
                    <details
                      className={
                        styles.stepResult
                      }
                    >
                      <summary>
                        {t("ai.plan.result")}
                      </summary>
                      {step.stdout && (
                        <pre>{step.stdout}</pre>
                      )}
                      {step.stderr && (
                        <pre
                          className={
                            styles.stepResultError
                          }
                        >
                          {step.stderr}
                        </pre>
                      )}
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {hiddenCount > 0 && (
          <button
            type="button"
            className={styles.moreBtn}
            aria-expanded={expanded}
            onClick={() =>
              setExpanded(open => !open)
            }
          >
            {/* 图标随状态变（搬 aicss 的 todoMoreGlyph）：
                收起态三点「⋯」= 还有藏的，展开态一横「−」= 点我收起。
                纯 SVG 不用图标库 —— 就两个字形，引一个组件不值当 */}
            <span
              className={styles.moreIcon}
              aria-hidden="true"
            >
              <svg
                className={styles.moreGlyph}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                {expanded ? (
                  <rect
                    x="4.75"
                    y="11.25"
                    width="14.5"
                    height="1.5"
                    rx="0.75"
                    fill="currentColor"
                  />
                ) : (
                  <>
                    <circle
                      cx="6"
                      cy="12"
                      r="1.25"
                      fill="currentColor"
                    />
                    <circle
                      cx="12"
                      cy="12"
                      r="1.25"
                      fill="currentColor"
                    />
                    <circle
                      cx="18"
                      cy="12"
                      r="1.25"
                      fill="currentColor"
                    />
                  </>
                )}
              </svg>
            </span>
            {expanded
              ? t("ai.plan.collapse")
              : t("ai.plan.more", {
                  count: hiddenCount
                })}
          </button>
        )}
      </div>

      <div className={styles.actions}>
        {call.state === "pending" &&
        awaitingConfirm ? (
          <>
            <button
              type="button"
              className={styles.btnGhost}
              disabled={busy}
              onClick={onReject}
            >
              {t("ai.plan.reject")}
            </button>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy}
              onClick={onApprove}
            >
              {t("ai.plan.approve")}
            </button>
          </>
        ) : (
          <span className={styles.planState}>
            {call.state === "running"
              ? t("ai.plan.running", {
                  done: doneCount,
                  total: call.steps.length
                })
              : call.state === "cancelled"
                ? t("ai.plan.cancelled")
                : call.state === "aborted"
                  ? t("ai.plan.aborted")
                  : call.state === "done"
                    ? t("ai.plan.done")
                    : t("ai.plan.pending")}
          </span>
        )}
      </div>
    </div>
  );
}
