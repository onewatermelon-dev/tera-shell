"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  FileTextOutlined,
  LoadingOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import Hint from "@/shared/components/Hint";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import { diffLanguageFor } from "@/terminal/lib/ai/fileDiff";
import {
  createTokenSource,
  type HighlightToken
} from "@/terminal/lib/codeHighlight";
import type {
  AiDiffLine,
  AiFileEditCall
} from "@/terminal/lib/ai/aiChat";
import styles from "./AiFileDiffCard.module.css";

/**
 * token 的内联样式。
 *
 * ⚠️ diff 区**固定用 One Dark Pro**（2026-10-18 用户要求）：token 的
 * 浅色值（One Light）直接丢弃，只取深色值 —— 代码区给了固定的深色
 * 编辑器底（见 CSS 的 .diff），亮主题下也是一块深色代码面板，对比度
 * 才站得住。One Light 那套亮色（#98c379 之流）放白底上几乎看不见，
 * 硬切主题只会「有颜色但看不清」。与终端 cat 同一个哲学：固定主题，
 * 不随终端配色变（catView.ts 的 ONE_DARK_PRO）。
 */
function tokenStyle(
  token: HighlightToken
): CSSProperties | undefined {
  const oneDark =
    token.htmlStyle?.["--shiki-dark"];
  return oneDark ? { color: oneDark } : undefined;
}

/**
 * 文件改动卡：模型提议改文件 → 客户端读真实文件算 diff → 用户审查 → 批准才写回。
 *
 * ⚠️ aicss 里**没有** FileDiff 组件（包里只有 approval-card / code-block /
 * data-table / task-list / text-response / thinking-* / orbs /
 * streaming-text / ai-agent-input）。本卡的视觉语言对齐项目里已移植的
 * aicss CodeBlock（AiCodeBlock）：等宽字体、行号列、圆角卡片同款栅格，
 * 审批按钮沿用 ApprovalCard 体系 —— 四张卡（命令/传输/计划/反问/改动）
 * 观感一致。diff 形态用 git 标准：红删绿增。
 *
 * 卡片自身不持面板状态，全部经 props 注入（同 ToolCard / AiPlanCard）。
 * diff 的计算与写回都不在组件里 —— 经 onLoad / onApprove / onCancel 交给
 * useAiChat（exec 通道、协议回填都在那儿）。
 */
export function AiFileDiffCard({
  call,
  busy,
  onLoad,
  onApprove,
  onCancel
}: {
  call: AiFileEditCall;
  busy: boolean;
  /** 挂载后触发：读真实文件 + 算 diff（幂等，loading 态才干活） */
  onLoad: () => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  // 进视野就加载 diff（loading 态幂等，重复触发无害）
  useEffect(() => {
    onLoad();
  }, [onLoad]);

  // ---- 语法着色（复用 AiCodeBlock 的 cli-highlight 双主题管线） ----
  // 高亮的是**整份旧内容与整份新内容**（不是逐行）—— 多行语境（块注释、
  // heredoc）才准确；token 按行号回填到 diff 行上。异步：首帧无色，
  // token 到了再重渲；请求序号防串台（文件内容不变时命中缓存同步给）。
  const [source] = useState(createTokenSource);
  const [tokenMaps, setTokenMaps] = useState<{
    old: HighlightToken[][];
    new: HighlightToken[][];
  } | null>(null);
  const requestRef = useRef(0);
  const language = diffLanguageFor(call.path);

  useEffect(() => {
    const oldContent = call.oldContent;
    const newContent = call.newContent;
    if (!oldContent || !newContent) return;
    const request = (requestRef.current += 1);
    const merge = (
      side: "old" | "new",
      tokens: HighlightToken[][]
    ) => {
      if (requestRef.current !== request) return;
      setTokenMaps(previous => ({
        old: previous?.old ?? [],
        new: previous?.new ?? [],
        [side]: tokens
      }));
    };
    const oldSync = source.get(
      oldContent,
      language,
      tokens => merge("old", tokens)
    );
    const newSync = source.get(
      newContent,
      language,
      tokens => merge("new", tokens)
    );
    if (oldSync) merge("old", oldSync);
    if (newSync) merge("new", newSync);
  }, [
    source,
    call.oldContent,
    call.newContent,
    language
  ]);

  /** 取某一行该用的 token：删/上下文取旧侧，增取新侧。 */
  const lineTokens = (
    line: AiDiffLine
  ): HighlightToken[] | undefined => {
    if (!tokenMaps) return undefined;
    const side =
      line.kind === "add"
        ? tokenMaps.new
        : tokenMaps.old;
    const lineNo =
      line.kind === "add"
        ? line.newLine
        : line.oldLine;
    if (lineNo == null) return undefined;
    return side[lineNo - 1];
  };

  const renderText = (line: AiDiffLine) => {
    const tokens = lineTokens(line);
    if (!tokens || tokens.length === 0)
      return line.text || " ";
    return tokens.map((token, index) => (
      <span
        key={index}
        className={styles.tok}
        style={tokenStyle(token)}
      >
        {token.content}
      </span>
    ));
  };

  return (
    <div
      className={styles.card}
      data-state={call.state}
    >
      <div className={styles.head}>
        <span className={styles.icon}>
          {call.state === "applied" ? (
            <CheckCircleFilled
              className={styles.iconSvg}
            />
          ) : call.state === "error" ? (
            <CloseCircleFilled
              className={styles.iconSvg}
            />
          ) : (
            <FileTextOutlined
              className={styles.iconSvg}
            />
          )}
        </span>
        <span className={styles.title}>
          {t("ai.edit.title")}
        </span>
        {/* 路径等宽显示，长路径截断；完整路径走 HeroUI 气泡
            （触发层是 Hint 的 div，flex 约束得挂在它身上，
            见 Hint 的 triggerClassName 注释） */}
        <Hint
          label={call.path}
          placement="bottom left"
          triggerClassName={styles.pathWrap}
          // 单行不折行；路径按自然宽度撑开（限宽 + nowrap 会让文字溢出）
          contentStyle={{ whiteSpace: "nowrap" }}
        >
          <span className={styles.path}>
            {call.path}
          </span>
        </Hint>
      </div>

      {call.summary && (
        <div className={styles.summary}>
          {sanitizeToolNames(call.summary)}
        </div>
      )}

      {call.state === "loading" && (
        <div className={styles.statusRow}>
          <LoadingOutlined
            className={styles.spin}
          />
          <span>{t("ai.edit.loading")}</span>
        </div>
      )}

      {call.state === "applying" && (
        <div className={styles.statusRow}>
          <LoadingOutlined
            className={styles.spin}
          />
          <span>{t("ai.edit.applying")}</span>
        </div>
      )}

      {call.state === "error" && (
        <div className={styles.error}>
          {sanitizeToolNames(call.error ?? "")}
        </div>
      )}

      {(call.state === "ready" ||
        call.state === "applying" ||
        call.state === "applied") &&
        call.hunks && (
          <div className={styles.diff}>
            {call.hunks.map((hunk, index) => (
              <div
                key={index}
                className={styles.hunk}
              >
                {/* 不渲染 @@ 行号头：每行都有旧/新行号列，
                    冗余信息只增噪音（2026-10-18 用户要求删） */}
                {hunk.lines.map(
                  (line, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={styles.diffLine}
                      data-kind={line.kind}
                    >
                      <span
                        className={styles.lineNo}
                      >
                        {line.oldLine ?? ""}
                      </span>
                      <span
                        className={styles.lineNo}
                      >
                        {line.newLine ?? ""}
                      </span>
                      {/* 增删标记列：git 标准的 +/-，
                          配色与行底色同一套（红删绿增） */}
                      <span
                        className={
                          styles.lineMark
                        }
                        data-kind={line.kind}
                      >
                        {line.kind === "add"
                          ? "+"
                          : line.kind === "remove"
                            ? "-"
                            : ""}
                      </span>
                      <code
                        className={
                          styles.lineText
                        }
                      >
                        {renderText(line)}
                      </code>
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        )}

      {/* 统计 + 操作 */}
      <div className={styles.actions}>
        {call.state === "ready" && (
          <span className={styles.stats}>
            <span className={styles.added}>
              +{call.addedLines ?? 0}
            </span>
            <span className={styles.removed}>
              −{call.removedLines ?? 0}
            </span>
          </span>
        )}
        {call.state === "applied" && (
          <span className={styles.stats}>
            <span className={styles.added}>
              +{call.addedLines ?? 0}
            </span>
            <span className={styles.removed}>
              −{call.removedLines ?? 0}
            </span>
          </span>
        )}
        {call.state === "ready" ? (
          <>
            <button
              type="button"
              className={styles.btnGhost}
              disabled={busy}
              onClick={onCancel}
            >
              {t("ai.edit.cancel")}
            </button>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy}
              onClick={onApprove}
            >
              {t("ai.edit.apply")}
            </button>
          </>
        ) : (
          <span className={styles.planState}>
            {call.state === "applied"
              ? t("ai.edit.applied")
              : call.state === "cancelled"
                ? t("ai.edit.cancelled")
                : call.state === "error"
                  ? t("ai.edit.failed")
                  : ""}
          </span>
        )}
      </div>
    </div>
  );
}
