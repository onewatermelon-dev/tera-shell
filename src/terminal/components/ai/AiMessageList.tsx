/**
 * AI 面板的消息流：欢迎卡片 + 历史条目 + 流式临时条目 + 错误行。
 *
 * 从 AiPanel.tsx 拆出（2026-10-13）：整段是「entries → 视图」的纯渲染，
 * 交互全部经 props 回传（确认/跳过/存宏），面板本体只剩布局与装配。
 */
import {
  useEffect,
  useMemo,
  useRef
} from "react";
import { useT } from "@/settings/lib/i18n";
import {
  describeAiError,
  parseAiError
} from "@/terminal/lib/ai/aiError";
import { AiMarkdown } from "./AiMarkdown";
import { ThinkingState } from "./ThinkingState";
import { ReasoningBlock } from "./ReasoningBlock";
import { ChatMessageActions } from "./ChatMessageActions";
import { ToolCard } from "./ToolCard";
import { FileCard } from "./FileCard";
import { AiPlanCard } from "./AiPlanCard";
import { AiQuestionCard } from "./AiQuestionCard";
import { AiFileDiffCard } from "./AiFileDiffCard";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import type {
  AiChatEntry,
  AiFileEditCall,
  ExecCardMode
} from "@/terminal/lib/ai/aiChat";

/** 欢迎卡片的示例提示池：每次卡片出现随机展示一条（文案在 i18n） */
const WELCOME_TIP_KEYS = [
  "ai.welcome.tip.0",
  "ai.welcome.tip.1",
  "ai.welcome.tip.2",
  "ai.welcome.tip.3",
  "ai.welcome.tip.4",
  "ai.welcome.tip.5",
  "ai.welcome.tip.6",
  "ai.welcome.tip.7"
] as const;

/** 正在流式生成的助手消息（null = 没有进行中的流）。 */
type AiStream = {
  text: string;
  reasoning: string;
};

export function AiMessageList({
  entries,
  stream,
  error,
  saveError,
  pendingCardId,
  busy,
  onConfirm,
  onConfirmFile,
  onSkip,
  onApprovePlan,
  onRejectPlan,
  onAnswerQuestions,
  onCancelQuestions,
  onLoadFileEdit,
  onApproveFileEdit,
  onCancelFileEdit,
  onRollbackFileEdit,
  onAddMacroCommand
}: {
  entries: AiChatEntry[];
  stream: AiStream | null;
  /** 聊天链路的错误气泡（来自 useAiChat） */
  error: string;
  /** 代码块/表格下载失败的提示（与 error 分开，见 AiPanel） */
  saveError: string;
  /** 等确认的卡片 id（useAiChat.pendingCardId） */
  pendingCardId: string | null;
  busy: boolean;
  onConfirm: (
    callId: string,
    mode: ExecCardMode
  ) => void;
  /** 文件传输卡片没有 terminal/background 之分，落点唯一 */
  onConfirmFile: (callId: string) => void;
  onSkip: (callId: string) => void;
  /** 批准执行一个多步计划 */
  onApprovePlan: (callId: string) => void;
  /** 取消一个待批准的多步计划 */
  onRejectPlan: (callId: string) => void;
  /** 提交一组反问的作答 */
  onAnswerQuestions: (
    callId: string,
    answers: Record<string, string>
  ) => void;
  /** 跳过一组反问 */
  onCancelQuestions: (callId: string) => void;
  /** 加载文件改动卡的 diff（读真实文件 + 算 diff） */
  onLoadFileEdit: (callId: string) => void;
  /** 批准一次文件改动（写回服务器） */
  onApproveFileEdit: (callId: string) => void;
  /** 取消一次文件改动（文件不被改动） */
  onCancelFileEdit: (callId: string) => void;
  /** 回滚一次已应用的文件改动（写回改动前原文） */
  onRollbackFileEdit: (
    call: AiFileEditCall
  ) => Promise<void>;
  /** 把卡片命令存为快捷宏 */
  onAddMacroCommand: (
    name: string,
    command: string
  ) => void;
}) {
  const t = useT();

  /**
   * 错误条上显示什么。
   *
   * AI 请求失败时后端抛的是一坨原始 JSON（`HTTP 429: {"error":…}`），
   * 直接甩给用户没法行动；这里翻成一句话。但**认不出类型时原样显示** ——
   * 别把「保存失败：磁盘只读」压成没信息量的「请求失败」。
   */
  const shownError = useMemo(() => {
    if (!error) return "";
    const parsed = parseAiError(error);
    return parsed.kind === "unknown"
      ? error
      : describeAiError(parsed, t);
  }, [error, t]);
  // 欢迎卡片的示例提示：卡片每次出现随机换一条 —— 依赖用 entries 的
  // 数组引用而非长度：点「新对话」时 clear() 换上新数组，即便此前也是
  // 空列表也会重抽。随机数发生在渲染期属于本功能的行为需求，显式豁免
  // purity 检查
  const welcomeTipKey = useMemo(
    () =>
      WELCOME_TIP_KEYS[
        Math.floor(
          // eslint-disable-next-line react-hooks/purity -- 欢迎语本就该随机
          Math.random() * WELCOME_TIP_KEYS.length
        )
      ] ?? WELCOME_TIP_KEYS[0],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entries 引用变化（含清空成新空数组）就是重抽时机
    [entries]
  );

  // 流式思考区（.ai-live-reasoning pre）超过 160px 上限后内部滚动，
  // 与面板本体同一套「贴底才跟随」礼仪：默认跟着最新文字走，用户
  // 翻上去看历史时不被拽回（onScroll 把 liveAtBottomRef 置 false）
  const liveReasoningRef =
    useRef<HTMLPreElement>(null);
  const liveAtBottomRef = useRef(true);
  const liveReasoning = stream?.reasoning ?? "";
  useEffect(() => {
    const node = liveReasoningRef.current;
    if (node && liveAtBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [liveReasoning]);
  // 离开底部 40px 以外算「翻历史」，停止跟随；贴回底部恢复
  const onLiveReasoningScroll = () => {
    const node = liveReasoningRef.current;
    if (!node) return;
    const distance =
      node.scrollHeight -
      node.scrollTop -
      node.clientHeight;
    liveAtBottomRef.current = distance < 40;
  };

  return (
    <>
      {entries.length === 0 && !error && (
        // 空面板欢迎卡片：介绍助手能力 + 一条随机示例用法（每次出现换一条）
        <div className="ai-welcome">
          <h3 className="ai-welcome-title">
            {t("ai.welcome.title")}
          </h3>
          <div className="ai-welcome-divider" />
          <p className="ai-welcome-desc">
            {t("ai.welcome.desc")}
          </p>
          <p className="ai-welcome-tip">
            💡 {t(welcomeTipKey)}
          </p>
        </div>
      )}
      {entries.map((entry, index) => {
        if (entry.kind === "tool") {
          return (
            <ToolCard
              key={entry.call.id}
              call={entry.call}
              awaitingConfirm={
                pendingCardId === entry.call.id
              }
              busy={busy}
              onConfirm={mode =>
                onConfirm(entry.call.id, mode)
              }
              onAddMacro={() =>
                onAddMacroCommand(
                  entry.call.question,
                  entry.call.command
                )
              }
              onSkip={() => onSkip(entry.call.id)}
            />
          );
        }
        if (entry.kind === "file") {
          return (
            <FileCard
              key={entry.call.id}
              call={entry.call}
              awaitingConfirm={
                pendingCardId === entry.call.id
              }
              busy={busy}
              onConfirm={() =>
                onConfirmFile(entry.call.id)
              }
              onSkip={() => onSkip(entry.call.id)}
            />
          );
        }
        if (entry.kind === "plan") {
          return (
            <AiPlanCard
              key={entry.call.id}
              call={entry.call}
              awaitingConfirm={
                pendingCardId === entry.call.id
              }
              pendingStepId={pendingCardId}
              busy={busy}
              onApprove={() =>
                onApprovePlan(entry.call.id)
              }
              onReject={() =>
                onRejectPlan(entry.call.id)
              }
              onConfirmStep={stepId =>
                onConfirm(stepId, "background")
              }
              onSkipStep={stepId =>
                onSkip(stepId)
              }
            />
          );
        }
        if (entry.kind === "question") {
          return (
            <AiQuestionCard
              key={entry.call.id}
              call={entry.call}
              busy={busy}
              onAnswer={answers =>
                onAnswerQuestions(
                  entry.call.id,
                  answers
                )
              }
              onSkip={() =>
                onCancelQuestions(entry.call.id)
              }
            />
          );
        }
        if (entry.kind === "edit") {
          return (
            <AiFileDiffCard
              key={entry.call.id}
              call={entry.call}
              busy={busy}
              onLoad={() =>
                onLoadFileEdit(entry.call.id)
              }
              onApprove={() =>
                onApproveFileEdit(entry.call.id)
              }
              onCancel={() =>
                onCancelFileEdit(entry.call.id)
              }
              onRollback={onRollbackFileEdit}
            />
          );
        }
        if (entry.kind === "assistant") {
          // 助手回复是 markdown（表格 / 代码块），交给 Streamdown 渲染
          return (
            <div
              key={`${index}-${entry.sentAt}`}
              className="ai-assistant-message"
            >
              <div className="ai-entry is-assistant">
                {entry.reasoning && (
                  <ReasoningBlock
                    reasoning={entry.reasoning}
                    elapsedSeconds={
                      entry.elapsedSeconds ?? 1
                    }
                  />
                )}
                {entry.text && (
                  <AiMarkdown text={entry.text} />
                )}
              </div>
              <ChatMessageActions
                text={sanitizeToolNames(
                  entry.text ||
                    entry.reasoning ||
                    "",
                  // 正文为空时会退回复制思考内容，那条路同样
                  // 按纯文本规则处理
                  entry.text
                    ? "markdown"
                    : "plain"
                )}
                sentAt={entry.sentAt}
                align="start"
                usage={entry.usage}
              />
            </div>
          );
        }
        // 用户消息的操作栏只在鼠标悬停或键盘聚焦时显示
        return (
          <div
            key={`${index}-${entry.sentAt}`}
            className="ai-user-message"
          >
            <div className="ai-entry is-user">
              {entry.images?.length ? (
                <span className="ai-entry-images">
                  {entry.images.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt=""
                    />
                  ))}
                </span>
              ) : null}
              {/* 用户消息同样走 markdown 渲染：贴代码块、表格时
                  纯文本 pre-wrap 排版没法看 */}
              <AiMarkdown text={entry.text} />
            </div>
            <ChatMessageActions
              text={entry.text}
              sentAt={entry.sentAt}
            />
          </div>
        );
      })}
      {stream && (
        // 流式进行中的临时条目：思考内容实时增长，正文就绪后交给 Streamdown
        <div className="ai-entry is-assistant">
          {stream.reasoning ? (
            <div className="ai-live-reasoning">
              <div className="ai-live-reasoning-head">
                <ThinkingState />
              </div>
              <pre
                ref={liveReasoningRef}
                onScroll={onLiveReasoningScroll}
              >
                {/* plain 模式：流式思考是 <pre> 纯文本，模型自己写的
                    ``` 分段不构成代码块保护理由 */}
                {sanitizeToolNames(
                  stream.reasoning,
                  "plain"
                )}
              </pre>
            </div>
          ) : (
            !stream.text && <ThinkingState />
          )}
          {stream.text && (
            <AiMarkdown
              text={stream.text}
              streaming
            />
          )}
        </div>
      )}
      {(error || saveError) && (
        <p className="ai-entry is-error">
          {error ? shownError : saveError}
        </p>
      )}
    </>
  );
}
