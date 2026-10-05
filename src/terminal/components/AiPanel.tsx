import {
  useEffect,
  useRef,
  useState
} from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { ThinkingState } from "@/terminal/components/aicss/ThinkingState";
import { Button, Modal } from "@heroui/react";
import {
  HistoryOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  RightOutlined,
  WarningFilled
} from "@ant-design/icons";
import {
  deleteHistory,
  loadHistories,
  renameHistory,
  type AiHistory
} from "@/terminal/lib/aiHistory";
import { ReasoningBlock } from "@/terminal/components/aicss/ReasoningBlock";
import { PromptInput } from "@/terminal/components/aicss/PromptInput";
import type { ExecCardMode } from "@/terminal/lib/aiChat";
import { useT } from "@/settings/lib/i18n";
import { ChatMessageActions } from "@/terminal/components/aicss/ChatMessageActions";
import { PROVIDERS_CHANGED_EVENT } from "@/settings/lib/modelProviders";
import {
  listOpenAiModels,
  loadBlacklist,
  loadRunFlag,
  loadSelectedModel,
  saveBlacklist,
  saveRunFlag,
  saveSelectedModel,
  useAiChat
} from "@/terminal/lib/aiChat";
import type { AiToolCall } from "@/terminal/lib/aiChat";
import AiBlacklistDialog from "@/terminal/components/AiBlacklistDialog";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

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

/** 执行卡片的可见文本与操作。 */
function ToolCard({
  call,
  awaitingConfirm,
  busy,
  onConfirm,
  onSkip,
  onAddMacro
}: {
  call: AiToolCall;
  awaitingConfirm: boolean;
  busy: boolean;
  /** mode：terminal = 写入活动终端；background = 独立 exec 通道 */
  onConfirm: (mode: ExecCardMode) => void;
  onSkip: () => void;
  /** 把这条命令存为快捷宏 */
  onAddMacro: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [macroAdded, setMacroAdded] =
    useState(false);
  const badge = call.isReadOnly
    ? t("ai.card.ro")
    : t("ai.card.rw");
  // 终端执行的命令拿不到退出码（-1 为未知），此时不展示括号
  // 完成态不展示退出码：命令是否成功由输出和模型解读决定
  const stateText =
    call.state === "running"
      ? t("ai.card.running")
      : call.state === "done"
        ? t("ai.card.done")
        : call.state === "failed"
          ? t("ai.card.failed")
          : awaitingConfirm
            ? t("ai.card.waiting")
            : "";

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(
        call.command
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默：低频辅助操作 */
    }
  }

  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <span className="ai-card-title">
          {t("ai.card.title")}
        </span>
        <span
          className={`ai-card-badge ${
            call.isReadOnly ? "ro" : "rw"
          }`}
          title={
            call.isReadOnly
              ? t("ai.badge.ro")
              : t("ai.badge.rw")
          }
        >
          {badge}
        </span>
      </div>
      <pre className="ai-card-command">
        {call.command}
      </pre>
      {call.question && (
        <div className="ai-card-question">
          <InfoCircleOutlined />
          {call.question}
        </div>
      )}
      <div className="ai-card-actions">
        <button
          type="button"
          className="ai-card-btn"
          onClick={() => {
            onAddMacro();
            setMacroAdded(true);
            setTimeout(
              () => setMacroAdded(false),
              1500
            );
          }}
        >
          {macroAdded
            ? t("ai.card.added")
            : t("ai.card.addMacro")}
        </button>
        <button
          type="button"
          className="ai-card-btn"
          onClick={() => void copyCommand()}
        >
          {copied
            ? t("ai.card.copied")
            : t("ai.card.copy")}
        </button>
        {awaitingConfirm && (
          <>
            <button
              type="button"
              className="ai-card-btn"
              disabled={busy}
              onClick={onSkip}
            >
              {t("ai.card.skip")}
            </button>
            <button
              type="button"
              className="ai-card-btn is-wide"
              disabled={busy}
              onClick={() =>
                onConfirm("terminal")
              }
            >
              ▶ {t("ai.card.execute")}
            </button>
            <button
              type="button"
              className="ai-card-btn is-primary is-wide"
              disabled={busy}
              onClick={() =>
                onConfirm("background")
              }
            >
              {t("ai.card.background")}
            </button>
          </>
        )}
        {!awaitingConfirm &&
          (call.state === "running" ||
            call.state === "failed" ||
            call.error) && (
            <span className="ai-card-state">
              {stateText}
            </span>
          )}
        {!awaitingConfirm &&
          call.state === "done" && (
            <span className="ai-card-state">
              {stateText}
            </span>
          )}
      </div>
      {(call.state === "done" ||
        call.state === "failed") && (
        <details className="ai-card-result">
          <summary>{t("ai.card.result")}</summary>
          {call.stdout && (
            <pre>{call.stdout}</pre>
          )}
          {call.stderr && (
            <pre className="is-error">
              {call.stderr}
            </pre>
          )}
          {!call.stdout && !call.stderr && (
            <pre>(无输出)</pre>
          )}
        </details>
      )}
      {call.state === "failed" && call.error && (
        <div className="ai-card-state is-error">
          {call.error}
        </div>
      )}
    </div>
  );
}

/** 开启「自动执行」前的安全确认弹窗：勾选知晓风险后才可确认。 */
function AutoExecuteRiskDialog({
  onConfirm,
  onClose
}: {
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [ack, setAck] = useState(false);
  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container
          placement="center"
          size="sm"
        >
          <Modal.Dialog className="ai-risk-dialog">
            <Modal.Header>
              <Modal.Heading>
                <span className="ai-risk-title">
                  <WarningFilled className="ai-risk-icon" />
                  安全提示
                </span>
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body>
              <p className="ai-risk-lead">
                开启自动执行只读命令存在潜在风险：
              </p>
              <ol className="ai-risk-list">
                <li>
                  命令的“只读”属性是由AI判断的，可能存在判断错误的情况。
                </li>
                <li>
                  自动执行可能导致意料之外的服务器状态变更或数据泄露。
                </li>
              </ol>
              <label className="ai-risk-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={event =>
                    setAck(event.target.checked)
                  }
                />
                我已知晓风险，并同意开启自动执行只读命令功能
              </label>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                size="sm"
                onPress={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={!ack}
                onPress={() => {
                  onConfirm();
                  onClose();
                }}
              >
                确认开启
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/**
 * SSH 会话右侧的 AI 助手面板：模型对话 + run_command 执行卡片。
 *
 * 模型走「模型设置」里 OpenAI 兼容的供应商；命令执行走独立 exec 通道
 * （aiRunCommand），只读/读写命令是否自动执行由输入框「+」菜单的
 * 「自动执行」「自动应用」开关控制，关闭时等用户确认。
 */
export default function AiPanel({
  collapsed,
  session,
  onAddMacroCommand,
  onCollapse
}: AiPanelProps) {
  const t = useT();
  // 供应商/模型在设置页即改即存，监听变更事件即时刷新「+」菜单
  const [options, setOptions] = useState(
    listOpenAiModels
  );
  useEffect(() => {
    const refresh = () =>
      setOptions(listOpenAiModels());
    window.addEventListener(
      PROVIDERS_CHANGED_EVENT,
      refresh
    );
    return () =>
      window.removeEventListener(
        PROVIDERS_CHANGED_EVENT,
        refresh
      );
  }, []);
  const [selectedKey, setSelectedKey] = useState(
    () => loadSelectedModel() ?? ""
  );
  // 「+」菜单里的执行策略开关（持久化，默认都关）
  const [autoExecute, setAutoExecute] = useState(
    () => loadRunFlag("autoExecute")
  );
  // 开启「自动执行」前的安全确认弹窗
  const [riskOpen, setRiskOpen] = useState(false);
  // 待发送的图片（data URL），随下一条消息带走并清空
  const [attachments, setAttachments] = useState<
    string[]
  >([]);
  const [autoApply, setAutoApply] = useState(() =>
    loadRunFlag("autoApply")
  );
  // 自动执行命令黑名单：命中即不出执行卡自动跑，回落为人工确认
  const [blacklist, setBlacklist] = useState(
    loadBlacklist
  );
  const [blacklistOpen, setBlacklistOpen] =
    useState(false);
  /** 增删黑名单条目并持久化。 */
  function updateBlacklist(list: string[]) {
    setBlacklist(list);
    saveBlacklist(list);
  }
  // 上次选中的模型可能已被删掉：找不到就退回第一个可选项
  const selected =
    options.find(
      o =>
        `${o.providerId}::${o.modelId}` ===
        selectedKey
    ) ??
    options[0] ??
    null;
  const {
    entries,
    busy,
    pendingCardId,
    error,
    stream,
    send,
    confirm,
    skip,
    clear,
    restore,
    renameCurrent
  } = useAiChat(session, {
    autoExecute,
    autoApply,
    blacklist
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  // 「历史任务」下拉：只列当前服务器的历史，点开可恢复续聊
  const [historyOpen, setHistoryOpen] =
    useState(false);
  const [histories, setHistories] = useState<
    AiHistory[]
  >([]);
  // 行内重命名的目标历史 id 与草稿
  const [renamingId, setRenamingId] = useState<
    string | null
  >(null);
  const [renameValue, setRenameValue] =
    useState("");
  const historyWrapRef =
    useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (event: PointerEvent) => {
      if (
        !historyWrapRef.current?.contains(
          event.target as Node
        )
      )
        setHistoryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        setHistoryOpen(false);
    };
    document.addEventListener(
      "pointerdown",
      onDown
    );
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener(
        "pointerdown",
        onDown
      );
      document.removeEventListener(
        "keydown",
        onKey
      );
    };
  }, [historyOpen]);

  function toggleHistory() {
    setHistories(
      loadHistories().filter(
        item => item.host === session.host
      )
    );
    setHistoryOpen(open => !open);
  }

  function commitRename() {
    const id = renamingId;
    if (!id) return;
    setRenamingId(null);
    const title = renameValue.trim().slice(0, 40);
    if (!title) return;
    renameHistory(id, title);
    setHistories(list =>
      list.map(item =>
        item.id === id ? { ...item, title } : item
      )
    );
    renameCurrent(id, title);
  }

  // 新消息 / 状态变化后滚到底部，聊天面板的默认阅读位置在最新一条
  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, error, pendingCardId, stream]);

  function pickModel(value: string) {
    setSelectedKey(value);
    saveSelectedModel(value);
  }

  function toggleAutoExecute(value: boolean) {
    // 开启需过安全确认弹窗；关闭直接生效
    if (value) {
      setRiskOpen(true);
      return;
    }
    setAutoExecute(false);
    saveRunFlag("autoExecute", false);
  }

  function confirmAutoExecute() {
    setAutoExecute(true);
    saveRunFlag("autoExecute", true);
  }

  function toggleAutoApply(value: boolean) {
    setAutoApply(value);
    saveRunFlag("autoApply", value);
  }

  return (
    <aside
      className="ai-panel"
      style={{
        display: collapsed ? "none" : undefined
      }}
    >
      <div className="ai-panel-head">
        <span>{t("ai.title")}</span>
        <div className="ai-panel-head-actions">
          <button
            type="button"
            className="ai-panel-clear"
            aria-label={t("ai.newChat")}
            title={t("ai.newChat")}
            onClick={clear}
          >
            <PlusOutlined />
          </button>
          <div
            className="ai-history-wrap"
            ref={historyWrapRef}
          >
            <button
              type="button"
              className="ai-panel-clear"
              aria-label={t("ai.history")}
              title={t("ai.history")}
              aria-expanded={historyOpen}
              onClick={toggleHistory}
            >
              <HistoryOutlined />
            </button>
            {historyOpen && (
              <div
                className="ai-history-menu"
                role="menu"
              >
                {histories.length === 0 && (
                  <p className="ai-history-empty">
                    {t("ai.history.empty")}
                  </p>
                )}
                {histories.map(history => (
                  <div
                    key={history.id}
                    className="ai-history-item"
                  >
                    {renamingId === history.id ? (
                      <input
                        className="ai-history-rename"
                        autoFocus
                        value={renameValue}
                        onChange={event =>
                          setRenameValue(
                            event.target.value
                          )
                        }
                        onKeyDown={event => {
                          if (
                            event.key === "Enter"
                          )
                            commitRename();
                          if (
                            event.key === "Escape"
                          ) {
                            event.stopPropagation();
                            setRenamingId(null);
                          }
                        }}
                        onBlur={commitRename}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="ai-history-name"
                          onClick={() => {
                            restore(history);
                            setHistoryOpen(false);
                          }}
                        >
                          {history.title}
                        </button>
                        <span className="ai-history-time">
                          {new Date(
                            history.updatedAt
                          ).toLocaleString(
                            "zh-CN",
                            {
                              hour12: false,
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit"
                            }
                          )}
                        </span>
                        <span className="ai-history-ops">
                          <button
                            type="button"
                            className="ai-history-op"
                            title={t(
                              "ai.history.rename"
                            )}
                            onClick={() => {
                              setRenamingId(
                                history.id
                              );
                              setRenameValue(
                                history.title
                              );
                            }}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="ai-history-op"
                            title={t(
                              "ai.history.delete"
                            )}
                            onClick={() => {
                              deleteHistory(
                                history.id
                              );
                              setHistories(list =>
                                list.filter(
                                  item =>
                                    item.id !==
                                    history.id
                                )
                              );
                            }}
                          >
                            ×
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
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
      <div
        className="ai-panel-body"
        ref={bodyRef}
      >
        {entries.length === 0 && !error && (
          // 空面板欢迎卡片：介绍助手能力 + 一条示例用法
          <div className="ai-welcome">
            <h3 className="ai-welcome-title">
              {t("ai.welcome.title")}
            </h3>
            <div className="ai-welcome-divider" />
            <p className="ai-welcome-desc">
              {t("ai.welcome.desc")}
            </p>
            <p className="ai-welcome-tip">
              💡 {t("ai.welcome.tip")}
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
                  void confirm(
                    entry.call.id,
                    selected,
                    mode
                  )
                }
                onAddMacro={() =>
                  onAddMacroCommand(
                    entry.call.question,
                    entry.call.command
                  )
                }
                onSkip={() =>
                  void skip(
                    entry.call.id,
                    selected
                  )
                }
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
                    <Streamdown>
                      {entry.text}
                    </Streamdown>
                  )}
                </div>
                <ChatMessageActions
                  text={
                    entry.text ||
                    entry.reasoning ||
                    ""
                  }
                  sentAt={entry.sentAt}
                  align="start"
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
                    {entry.images.map(
                      (url, i) => (
                        <img
                          key={i}
                          src={url}
                          alt=""
                        />
                      )
                    )}
                  </span>
                ) : null}
                {entry.text}
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
                <pre>{stream.reasoning}</pre>
              </div>
            ) : (
              !stream.text && <ThinkingState />
            )}
            {stream.text && (
              <Streamdown>
                {stream.text}
              </Streamdown>
            )}
          </div>
        )}
        {error && (
          <p className="ai-entry is-error">
            {error}
          </p>
        )}
      </div>
      {/* 输入框：@aicss/react PromptInput 改造版，模型选择在「+」菜单里 */}
      <div className="ai-panel-compose">
        <PromptInput
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
          busy={busy}
          placeholder={t("ai.input")}
          onSend={text => {
            void send(
              text,
              selected,
              attachments
            );
            setAttachments([]);
          }}
        />
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
