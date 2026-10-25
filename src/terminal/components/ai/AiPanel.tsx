import { logError } from "@/shared/lib/log";
import {
  useEffect,
  useCallback,
  useRef,
  useState
} from "react";
import "streamdown/styles.css";
import { invoke } from "@tauri-apps/api/core";
import {
  PlusOutlined,
  RightOutlined,
  SafetyOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { logInfo } from "@/shared/lib/log";
import {
  clearEscalation,
  hasEscalationPassword,
  setEscalationPasswords
} from "@/terminal/lib/ai/escalation";
import {
  useAiChat,
  type AiChatEntry
} from "@/terminal/lib/ai/aiChat";
import type { AiHistory } from "@/terminal/lib/ai/aiHistory";
import {
  buildRunbook,
  runbookFileName
} from "@/terminal/lib/ai/runbook";
import {
  AI_ASK_PRESETS,
  onAiAsk
} from "@/terminal/lib/ai/askFromTerminal";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import { attachStreamdownExport } from "@/terminal/lib/streamdownExport";
import { AiMessageList } from "./AiMessageList";
import { AiHistoryMenu } from "./AiHistoryMenu";
import { AiMultiExec } from "./AiMultiExec";
import { AiHostNotes } from "./AiHostNotes";
import {
  canRollback,
  loadEditHistory,
  rollbackEdit
} from "@/terminal/lib/ai/editHistory";
import { AutoExecuteRiskDialog } from "./AutoExecuteRiskDialog";
import { PromptInput } from "./PromptInput";
import { QueuedMessageRow } from "./QueuedMessageRow";
import AiBlacklistDialog from "./AiBlacklistDialog";
import { useQueueDrag } from "./useQueueDrag";
import { useAiPanelSettings } from "./useAiPanelSettings";

type AiPanelProps = {
  /** 收起时保留当前对话状态。 */
  collapsed: boolean;
  /** 当前激活的 SSH 会话（命令执行目标与上下文来源）。 */
  session: OpenSession;
  /** 把卡片命令存为快捷宏：名称用命令下方的说明文字，留空由宏层兜底用命令。 */
  onAddMacroCommand: (
    name: string,
    command: string
  ) => void;
  /** 收起面板：贴到窗口右缘成浮窗按钮。 */
  onCollapse: () => void;
};

/**
 * SSH 会话右侧的 AI 助手面板：模型对话 + run_command 执行卡片。
 *
 * 模型走「模型设置」里 OpenAI 兼容的供应商；命令执行走独立 exec 通道
 * （aiRunCommand），只读/读写命令是否自动执行由输入框「+」菜单的
 * 「自动执行」「自动应用」开关控制，关闭时等用户确认。
 *
 * 2026-10-13 拆分：本文件只留布局与装配，各块独立成模块 ——
 * - AiMessageList.tsx      消息流（欢迎卡/历史/流式/错误）
 * - AiHistoryMenu.tsx      「历史任务」下拉与行内重命名
 * - ToolCard.tsx           命令执行卡片
 * - AutoExecuteRiskDialog.tsx 自动执行安全确认弹窗
 * - useQueueDrag.ts        排队消息拖拽换序
 * - useAiPanelSettings.ts  模型/开关/黑名单（即改即存）
 */
export default function AiPanel({
  collapsed,
  session,
  onAddMacroCommand,
  onCollapse
}: AiPanelProps) {
  const t = useT();
  // ---- 提权凭据（只存内存，重启清空）----
  // 两个密码必须分开：sudo 要登录账号的密码，su 要 root 的密码
  const [escalateOpen, setEscalateOpen] =
    useState(false);
  const [sudoValue, setSudoValue] = useState("");
  const [suValue, setSuValue] = useState("");
  const [escalateOn, setEscalateOn] = useState(
    () => hasEscalationPassword(session.id)
  );
  /** 保存提权密码：之后 AI 需要 root 的命令会自动以 root 执行。 */
  function saveEscalation() {
    setEscalationPasswords(session.id, {
      sudoPassword: sudoValue,
      suPassword: suValue
    });
    const on = hasEscalationPassword(session.id);
    setEscalateOn(on);
    setEscalateOpen(false);
    setSudoValue("");
    setSuValue("");
    logInfo("[ai] 提权凭据已设置（仅本次运行）", {
      sudo: sudoValue.trim().length > 0,
      su: suValue.trim().length > 0
    });
  }
  /** 关闭提权：AI 命令恢复普通身份。 */
  function disableEscalation() {
    clearEscalation();
    setEscalateOn(false);
    setEscalateOpen(false);
    logInfo("[ai] 已关闭提权执行");
  }
  /**
   * 换会话 / 新建聊天 / 打开历史时**一律作废凭据**：上一台机器的 root
   * 密码不该继续用于下一台。用户需要重新输入。
   */
  useEffect(() => {
    // 凭据本身已按会话绑定（读不到就是失效），这里只是把 UI 的开关灯
    // 一起熄掉；放进微任务避免 set-state-in-effect 判成级联渲染
    void Promise.resolve().then(() => {
      setEscalateOn(false);
      setEscalateOpen(false);
    });
  }, [session.id]);
  const {
    options,
    selected,
    autoExecute,
    autoApply,
    blacklist,
    riskOpen,
    setRiskOpen,
    blacklistOpen,
    setBlacklistOpen,
    updateBlacklist,
    pickModel,
    toggleAutoExecute,
    confirmAutoExecute,
    toggleAutoApply
  } = useAiPanelSettings();
  const {
    entries,
    busy,
    pendingCardId,
    error,
    stream,
    title,
    queued,
    send,
    stop,
    confirm,
    skip,
    approvePlan,
    rejectPlan,
    answerQuestions,
    cancelQuestions,
    loadFileEdit,
    approveFileEdit,
    cancelFileEdit,
    clear,
    restore,
    renameCurrent,
    updateQueued,
    removeQueued,
    reorderQueued,
    nudgeQueuedBy
  } = useAiChat(session, {
    autoExecute,
    autoApply,
    blacklist
  });
  // 排队消息的拖拽换序（hook 自持「谁在被拖 / 谁是落点」）
  const { dragId, dropId, startQueueDrag } =
    useQueueDrag(queued, reorderQueued);
  // 待发送的图片（data URL），随下一条消息带走并清空
  const [attachments, setAttachments] = useState<
    string[]
  >([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 用户是否还贴着消息流底部。流式期间每个 chunk 都会换 stream 引用、
  // 触发下面的自动滚动；只有贴着底部时才跟随 —— 否则用户往上翻历史
  // 会被反复拽回底部（滚轮先把 atBottomRef 置 false，下一个 chunk 的
  // effect 就不抢了）。
  const atBottomRef = useRef(true);
  // 代码块「下载」失败的提示。单独一个 state 而不是复用 useAiChat 的
  // error：那个是聊天链路的错误气泡（会被 clear/restore 重置），
  // 混进去会被下一轮发送顺手清掉，用户刚看到就消失。
  const [saveError, setSaveError] = useState("");
  // 接管 Streamdown 的下载按钮（代码块 + 表格）：它们用浏览器原生下载，
  // WebView2 会静默丢弃，点按钮毫无反应。改成弹系统另存为框
  // （见 streamdownExport.ts）。
  useEffect(
    () => attachStreamdownExport(setSaveError),
    []
  );
  // 新消息 / 状态变化后滚到底部，聊天面板的默认阅读位置在最新一条
  // （仅当用户还贴着底部；翻历史时不被拽回，见 atBottomRef）
  useEffect(() => {
    const node = bodyRef.current;
    if (node && atBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries, error, pendingCardId, stream]);
  // 导出 Runbook：**只按历史条目导出**（逐条）。
  // 历史里自带 entries 快照（见 AiHistory），所以不用先恢复就能导出；
  // 当前对话由引擎空闲时自动落盘进历史，它自己就在列表第一行。
  const exportRunbook = useCallback(
    (history: AiHistory) => {
      const createdAt = Date.now();
      const source = (
        history.entries as AiChatEntry[]
      ).filter(Boolean);
      if (source.length === 0) {
        console.info(
          "[ai] 这条历史没有可导出的内容，跳过"
        );
        return;
      }
      const content = buildRunbook(source, {
        host: history.host,
        createdAt
      });
      const suggestedName = runbookFileName(
        source,
        history.host,
        createdAt
      );
      void invoke<string | null>(
        "fs_save_text_file",
        { content, suggestedName }
      )
        .then(path => {
          if (path)
            console.info(
              `[ai] Runbook 已导出到 ${path}`
            );
          else
            console.info(
              "[ai] 用户取消了 Runbook 导出"
            );
        })
        .catch(reason => {
          logError(
            "[ai] 导出 Runbook 失败",
            reason
          );
          setSaveError(t("ai.runbook.failed"));
        });
    },
    [t]
  );
  // 终端右键「解释这条 / 让 AI 看看」：菜单经 askFromTerminal 桥把终端
  // 内容送进来，这里直接作为一轮提问发出。面板收起时由
  // TerminalWorkspace 订阅同一事件展开 —— 那边只负责展开，不管发送，
  // 模型选项在面板里取（selected），发送语义不外溢。
  useEffect(
    () =>
      onAiAsk(({ preset, text }) => {
        console.info(
          "[ai] 终端右键提问：",
          preset
        );
        void send(
          AI_ASK_PRESETS[preset].prompt(text),
          selected
        );
      }),
    [send, selected]
  );
  // 用户主动滚动（滚轮 / 滚动条）：离开底部 80px 以外算「翻历史」，
  // 停止自动跟随；重新贴回底部则恢复跟随
  const onBodyScroll = () => {
    const node = bodyRef.current;
    if (!node) return;
    const distance =
      node.scrollHeight -
      node.scrollTop -
      node.clientHeight;
    atBottomRef.current = distance < 80;
  };

  return (
    <aside
      className="ai-panel"
      style={{
        display: collapsed ? "none" : undefined
      }}
    >
      <div className="ai-panel-head">
        <span className="ai-panel-head-brand">
          {t("ai.title")}
        </span>
        {/* 当前对话标题：居中在「AI 助手」与「新对话」按钮之间。
            没起标题（新对话刚点开、还没发过消息）时不渲染 —— 元素缺席时
            右侧动作组会滑进中间列，所以那一列在 scss 里用
            grid-column: 3 钉住，两侧各归各位、布局不塌。 */}
        {title && (
          <span
            className="ai-panel-head-title"
            title={title}
          >
            {title}
          </span>
        )}
        <div className="ai-panel-head-actions">
          {/* 提权：配了密码后 AI 的命令自动以 root 执行 */}
          <button
            type="button"
            className={
              escalateOn
                ? "ai-panel-clear ai-escalate-toggle is-on"
                : "ai-panel-clear ai-escalate-toggle"
            }
            aria-label={t("ai.escalate.title")}
            title={
              escalateOn
                ? t("ai.escalate.on")
                : t("ai.escalate.title")
            }
            onClick={() =>
              setEscalateOpen(open => !open)
            }
          >
            <SafetyOutlined />
          </button>
          <button
            type="button"
            className="ai-panel-clear"
            aria-label={t("ai.newChat")}
            title={t("ai.newChat")}
            onClick={() => {
              // 新建聊天 = 新一段对话，凭据一起作废
              clearEscalation();
              setEscalateOn(false);
              setEscalateOpen(false);
              clear();
            }}
          >
            <PlusOutlined />
          </button>
          <AiHistoryMenu
            host={session.host}
            onRestore={history => {
              // 打开另一段历史 = 换了一段对话，凭据一起作废
              clearEscalation();
              setEscalateOn(false);
              setEscalateOpen(false);
              // 阅读位置重置到最新一条，不管之前翻到哪里
              atBottomRef.current = true;
              restore(history);
            }}
            renameCurrent={renameCurrent}
            onExportRunbook={exportRunbook}
          />
          <AiMultiExec
            blacklist={blacklist}
            onSend={markdown => {
              // 结果表格作为用户消息进对话流，模型续一轮汇总诊断
              atBottomRef.current = true;
              void send(markdown, selected);
            }}
          />
          <AiHostNotes session={session} />
          <button
            type="button"
            className="ai-panel-clear"
            aria-label={t("ai.collapse")}
            title={t("ai.collapse")}
            onClick={onCollapse}
          >
            <RightOutlined />
          </button>
        </div>
      </div>
      {/* 提权密码：只存内存（重启失效），保存后 AI 的命令自动以 root 执行 */}
      {escalateOpen && (
        <div className="ai-escalate">
          <input
            type="password"
            className="ai-escalate-input"
            placeholder={t(
              "ai.escalate.sudoPlaceholder"
            )}
            value={sudoValue}
            autoFocus
            onChange={event =>
              setSudoValue(event.target.value)
            }
            onKeyDown={event => {
              if (event.key === "Enter")
                saveEscalation();
            }}
          />
          <input
            type="password"
            className="ai-escalate-input"
            placeholder={t(
              "ai.escalate.suPlaceholder"
            )}
            value={suValue}
            onChange={event =>
              setSuValue(event.target.value)
            }
            onKeyDown={event => {
              if (event.key === "Enter")
                saveEscalation();
            }}
          />
          <button
            type="button"
            className="ai-escalate-btn"
            onClick={saveEscalation}
          >
            {t("ai.escalate.save")}
          </button>
          {escalateOn && (
            <button
              type="button"
              className="ai-escalate-btn"
              onClick={disableEscalation}
            >
              {t("ai.escalate.clear")}
            </button>
          )}
        </div>
      )}
      <div
        className="ai-panel-body"
        ref={bodyRef}
        onScroll={onBodyScroll}
      >
        <AiMessageList
          entries={entries}
          stream={stream}
          error={error}
          saveError={saveError}
          pendingCardId={pendingCardId}
          busy={busy}
          onConfirm={(callId, mode) => {
            void confirm(callId, selected, mode);
          }}
          onConfirmFile={callId => {
            void confirm(callId, selected);
          }}
          onSkip={callId => {
            void skip(callId, selected);
          }}
          onApprovePlan={callId => {
            void approvePlan(callId, selected);
          }}
          onRejectPlan={callId => {
            void rejectPlan(callId, selected);
          }}
          onAnswerQuestions={(
            callId,
            answers
          ) => {
            void answerQuestions(
              callId,
              selected,
              answers
            );
          }}
          onCancelQuestions={callId => {
            void cancelQuestions(
              callId,
              selected
            );
          }}
          onLoadFileEdit={callId => {
            void loadFileEdit(callId);
          }}
          onApproveFileEdit={callId => {
            void approveFileEdit(
              callId,
              selected
            );
          }}
          onCancelFileEdit={callId => {
            void cancelFileEdit(callId, selected);
          }}
          onRollbackFileEdit={async call => {
            // 按 historyId 从落盘历史里取回原文再写一次；
            // 主机不匹配 / 原文未留存 / 已回滚过都在 canRollback 里拦
            const entry = loadEditHistory().find(
              item => item.id === call.historyId
            );
            if (!entry) {
              throw new Error(
                "找不到这条变更的历史记录"
              );
            }
            if (!canRollback(entry, session)) {
              throw new Error(
                t("ai.editHistory.hostMismatch")
              );
            }
            await rollbackEdit(entry, session);
          }}
          onAddMacroCommand={onAddMacroCommand}
        />
      </div>
      {/* 排队中的消息：AI 还在跑时用户发的消息排在这里，等本轮结束
          自动接着发。位置在**消息流与输入框之间**（截图里的位置），
          不塞进消息流 —— 消息流是"已发出的历史"，混进去会分不清
          哪些已经问过了。 */}
      {queued.length > 0 && (
        <div className="ai-queue">
          <div className="ai-queue-hint">
            {t("ai.queue.hint", {
              count: queued.length
            })}
          </div>
          <div className="ai-queue-list">
            {queued.map(message => (
              <QueuedMessageRow
                key={message.id}
                message={message}
                onUpdate={updateQueued}
                onRemove={removeQueued}
                dragging={dragId === message.id}
                dropTarget={
                  dropId === message.id &&
                  dragId !== message.id
                }
                onDragStart={startQueueDrag}
                onNudge={nudgeQueuedBy}
              />
            ))}
          </div>
        </div>
      )}
      {/* 输入框：@aicss/react PromptInput 改造版，模型选择在「+」菜单里 */}
      <div className="ai-panel-compose">
        <PromptInput
          session={session}
          models={options.map(option => ({
            id: `${option.providerId}::${option.modelId}`,
            name: option.model.name,
            provider: option.provider.name
          }))}
          modelId={
            selected
              ? `${selected.providerId}::${selected.modelId}`
              : ""
          }
          onModelChange={pickModel}
          autoExecute={autoExecute}
          onAutoExecuteChange={toggleAutoExecute}
          autoApply={autoApply}
          onAutoApplyChange={toggleAutoApply}
          onOpenBlacklist={() =>
            setBlacklistOpen(true)
          }
          images={attachments}
          onAddImages={urls =>
            setAttachments(list => [
              ...list,
              ...urls
            ])
          }
          onRemoveImage={index =>
            setAttachments(list =>
              list.filter((_, i) => i !== index)
            )
          }
          history={entries.flatMap(entry =>
            entry.kind === "user" && entry.text
              ? [entry.text]
              : []
          )}
          placeholder={t("ai.input")}
          onSend={text => {
            // 新消息强制回底：这一轮的回答从最新一条开始看，
            // 不管之前把历史翻到了哪里
            atBottomRef.current = true;
            void send(
              text,
              selected,
              attachments
            );
            // 可以立刻清附件：enqueueMessage / dispatch 落库时都复制了
            // attachments（队列条目与这里不是同一个数组引用）
            setAttachments([]);
          }}
          busy={busy || Boolean(pendingCardId)}
          onStop={stop}
        />
        {/* busy 要传 `busy || Boolean(pendingCardId)`：等确认卡片时
            runLoop 会把 busy 置回 false（否则卡片上的执行/跳过按钮会被
            自己的 disabled 卡住），但本轮并没有结束 —— 只传 busy 的话
            底部按钮会在弹卡片那一刻退回发送态，看着能发消息，实际既没有
            HTTP 流也没有工具循环在跑，点了什么也不会发生。*/}
      </div>
      {riskOpen && (
        <AutoExecuteRiskDialog
          onConfirm={confirmAutoExecute}
          onClose={() => setRiskOpen(false)}
        />
      )}
      {blacklistOpen && (
        <AiBlacklistDialog
          blacklist={blacklist}
          onChange={updateBlacklist}
          onClose={() => setBlacklistOpen(false)}
        />
      )}
    </aside>
  );
}
