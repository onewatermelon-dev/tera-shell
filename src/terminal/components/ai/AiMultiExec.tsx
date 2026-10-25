/**
 * 「批量执行」弹层，两个标签页：
 *
 * - 多机命令：选一批 SSH 会话并发跑同一条命令（ExecPool 天然并发）；
 * - Runbook：当前会话按步执行命名命令序列（runbookLibrary），支持
 *   {{占位符}} 参数化。
 *
 * 两条链路的结果都以 markdown 表格发进 AI 对话流，模型续一轮汇总
 * 诊断 —— 复用 Streamdown 渲染与「存为宏/导出」等对话流能力。
 * 黑名单命中直接拒绝；执行按钮两击确认，防手滑。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ClusterOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { loadSessions } from "@/sessions/lib/useSessions";
import { type SavedSession } from "@/sessions/lib/session";
import {
  parseGroups,
  UNGROUPED_ID,
  type SessionGroup
} from "@/sessions/lib/sessionGroup";
import {
  DataName,
  readData
} from "@/settings/lib/storage";
import { buildSshTarget } from "@/sessions/lib/sshTarget";
import { logError } from "@/shared/lib/log";
import {
  buildResultMarkdown,
  checkMultiExecBlacklist,
  runOnHosts,
  type MultiExecHost
} from "@/terminal/lib/ai/multiExec";
import {
  applyPlaceholders,
  buildStepsMarkdown,
  deleteRunbook,
  extractPlaceholders,
  loadRunbooks,
  runSteps,
  saveRunbook,
  type RunbookEntry
} from "@/terminal/lib/ai/runbookLibrary";
import { execTargetOf } from "@/sessions/lib/sshTarget";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

export function AiMultiExec({
  session,
  blacklist,
  onSend
}: {
  /** 当前会话：Runbook 的执行目标（exec 通道） */
  session: OpenSession;
  /** 命令黑名单（与 AI 命令执行同一份） */
  blacklist: string[];
  /** 执行完成：把结果表格发进对话流 */
  onSend: (markdown: string) => void;
}) {
  const t = useT();
  // 开合状态自包含（同 AiHostNotes / AiHistoryMenu 模式）
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<
    "multi" | "runbook"
  >("multi");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (
        !wrapRef.current?.contains(
          event.target as Node
        )
      )
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
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
  }, [open]);

  // ---- 多机命令 tab 的状态 ----
  const saved = useMemo(() => loadSessions(), []);
  const sshSessions = useMemo(
    () =>
      saved.filter(item => item.kind === "ssh"),
    [saved]
  );
  const groups: SessionGroup[] = useMemo(
    () => parseGroups(readData(DataName.groups)),
    []
  );
  const [selected, setSelected] = useState<
    Set<string>
  >(() => new Set());
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({
    done: 0,
    total: 0
  });
  const [confirming, setConfirming] =
    useState(false);
  const [error, setError] = useState("");

  /** 分组名 → 该组下可选的会话（未分组排最后） */
  const sections = useMemo(() => {
    const named = groups.map(group => ({
      label: group.name,
      items: sshSessions.filter(
        item => item.groupId === group.id
      )
    }));
    const rest = sshSessions.filter(
      item =>
        !item.groupId ||
        item.groupId === UNGROUPED_ID ||
        !groups.some(
          group => group.id === item.groupId
        )
    );
    if (rest.length)
      named.push({
        label: t("sidebar.ungrouped"),
        items: rest
      });
    return named.filter(
      section => section.items.length > 0
    );
  }, [groups, sshSessions, t]);

  function toggle(id: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function execute() {
    if (!command.trim() || selected.size === 0)
      return;
    // 两击确认：整组机器发命令，单击就跑太容易手滑
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    // 黑名单与 AI 命令执行同一份口径
    const blocked = checkMultiExecBlacklist(
      command,
      blacklist
    );
    if (blocked) {
      setError(blocked);
      return;
    }
    setError("");
    setRunning(true);
    setProgress({
      done: 0,
      total: selected.size
    });
    try {
      const chosen = sshSessions.filter(item =>
        selected.has(item.id)
      );
      // 目标现场构造：密文解密 + 跳板链解析与 SFTP 同源；
      // 单台构造失败只跳过该台（如密码解不开），不拖垮整批
      const hosts: MultiExecHost[] = [];
      for (const item of chosen) {
        try {
          hosts.push({
            id: item.id,
            name: item.name || item.host,
            target: await buildSshTarget(
              item,
              saved
            )
          });
        } catch (reason) {
          logError(
            "[multi-exec] 构造连接目标失败，跳过",
            item.name,
            reason
          );
        }
      }
      if (hosts.length === 0) {
        setError(t("ai.multiExec.noTargets"));
        setRunning(false);
        return;
      }
      const results = await runOnHosts(
        hosts,
        command,
        (done, total) =>
          setProgress({ done, total })
      );
      setRunning(false);
      onSend(
        buildResultMarkdown(command, results)
      );
      setOpen(false);
    } catch (reason) {
      logError(
        "[multi-exec] 批量执行失败",
        reason
      );
      setError(String(reason));
      setRunning(false);
    }
  }

  // ---- Runbook tab 的状态 ----
  const [runbooks, setRunbooks] = useState<
    RunbookEntry[]
  >([]);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    commandsText: string;
  } | null>(null);
  const [activeId, setActiveId] = useState<
    string | null
  >(null);
  const [paramValues, setParamValues] = useState<
    Record<string, string>
  >({});

  const active = runbooks.find(
    item => item.id === activeId
  );
  const activeParams = useMemo(
    () =>
      active
        ? extractPlaceholders(active.commands)
        : [],
    [active]
  );

  async function executeRunbook(
    entry: RunbookEntry
  ) {
    setError("");
    let target: ReturnType<typeof execTargetOf>;
    try {
      target = execTargetOf(session);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    // 黑名单逐条校验（任意一步命中整体拒绝）
    for (const command of entry.commands) {
      const blocked = checkMultiExecBlacklist(
        command,
        blacklist
      );
      if (blocked) {
        setError(
          `${blocked}：${command.slice(0, 60)}`
        );
        return;
      }
    }
    setRunning(true);
    setProgress({
      done: 0,
      total: entry.commands.length
    });
    const filled = applyPlaceholders(
      entry.commands,
      paramValues
    );
    const results = await runSteps(
      target,
      filled,
      (done, total) =>
        setProgress({ done, total })
    );
    setRunning(false);
    onSend(
      buildStepsMarkdown(entry.title, results)
    );
    setOpen(false);
  }

  function commitEditing() {
    if (!editing) return;
    const title = editing.title.trim();
    const commands = editing.commandsText
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    if (!title || commands.length === 0) return;
    saveRunbook({
      id: editing.id,
      title,
      commands,
      createdAt: Date.now()
    });
    setRunbooks(loadRunbooks());
    setEditing(null);
  }

  return (
    <div
      className="ai-history-wrap"
      ref={wrapRef}
    >
      <button
        type="button"
        className="ai-panel-clear"
        aria-label={t("ai.multiExec")}
        title={t("ai.multiExec")}
        aria-expanded={open}
        onClick={() => {
          setError("");
          setConfirming(false);
          // 打开时刷新库列表（别的窗口可能改过）
          setRunbooks(loadRunbooks());
          setOpen(value => !value);
        }}
      >
        <ClusterOutlined />
      </button>
      {open && (
        <div
          className="ai-history-menu ai-multiexec"
          role="dialog"
        >
          <div
            className="ai-multiexec-tabs"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "multi"}
              className={
                tab === "multi" ? "is-active" : ""
              }
              onClick={() => setTab("multi")}
            >
              <ClusterOutlined />
              {t("ai.multiExec.tabMulti")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "runbook"}
              className={
                tab === "runbook"
                  ? "is-active"
                  : ""
              }
              onClick={() => setTab("runbook")}
            >
              <PlayCircleOutlined />
              {t("ai.multiExec.tabRunbook")}
            </button>
          </div>

          {tab === "multi" ? (
            <>
              <div className="ai-multiexec-hosts">
                {sections.length === 0 && (
                  <p className="ai-history-empty">
                    {t("ai.multiExec.noSessions")}
                  </p>
                )}
                {sections.map(section => (
                  <div key={section.label}>
                    <p className="ai-multiexec-section">
                      {section.label}
                    </p>
                    {section.items.map(
                      (item: SavedSession) => (
                        <label
                          key={item.id}
                          className="ai-multiexec-host"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(
                              item.id
                            )}
                            onChange={() =>
                              toggle(item.id)
                            }
                          />
                          <span>
                            {item.name ||
                              item.host}
                          </span>
                          <span className="ai-multiexec-addr">
                            {item.host}
                          </span>
                        </label>
                      )
                    )}
                  </div>
                ))}
              </div>
              <textarea
                className="ai-multiexec-cmd"
                value={command}
                onChange={event =>
                  setCommand(event.target.value)
                }
                placeholder={t(
                  "ai.multiExec.placeholder"
                )}
                rows={2}
                spellCheck={false}
              />
            </>
          ) : editing ? (
            <>
              <input
                className="ai-multiexec-cmd"
                value={editing.title}
                onChange={event =>
                  setEditing({
                    ...editing,
                    title: event.target.value
                  })
                }
                placeholder={t(
                  "ai.runbook.titlePlaceholder"
                )}
                spellCheck={false}
              />
              <textarea
                className="ai-multiexec-cmd"
                value={editing.commandsText}
                onChange={event =>
                  setEditing({
                    ...editing,
                    commandsText:
                      event.target.value
                  })
                }
                placeholder={t(
                  "ai.runbook.commandsPlaceholder"
                )}
                rows={6}
                spellCheck={false}
              />
              <div className="ai-multiexec-foot">
                <button
                  type="button"
                  className="ai-hostnotes-save"
                  style={{
                    background: "var(--surface)",
                    color: "var(--muted)",
                    borderColor: "var(--border)"
                  }}
                  onClick={() => setEditing(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="ai-hostnotes-save"
                  disabled={
                    !editing.title.trim() ||
                    !editing.commandsText.trim()
                  }
                  onClick={commitEditing}
                >
                  {t("common.save")}
                </button>
              </div>
            </>
          ) : (
            <div className="ai-multiexec-hosts">
              {runbooks.length === 0 && (
                <p className="ai-history-empty">
                  {t("ai.runbook.empty")}
                </p>
              )}
              {runbooks.map(entry => (
                <div
                  key={entry.id}
                  className="ai-multiexec-host"
                  data-active={
                    activeId === entry.id
                  }
                >
                  <button
                    type="button"
                    className="ai-runbook-pick"
                    onClick={() =>
                      setActiveId(
                        activeId === entry.id
                          ? null
                          : entry.id
                      )
                    }
                  >
                    <span>{entry.title}</span>
                    <span className="ai-multiexec-addr">
                      {t("ai.runbook.stepCount", {
                        count:
                          entry.commands.length
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="sys-icon-btn"
                    aria-label={t(
                      "ai.history.rename"
                    )}
                    onClick={() =>
                      setEditing({
                        id: entry.id,
                        title: entry.title,
                        commandsText:
                          entry.commands.join(
                            "\n"
                          )
                      })
                    }
                  >
                    <EditOutlined />
                  </button>
                  <button
                    type="button"
                    className="sys-icon-btn"
                    aria-label={t(
                      "ai.history.delete"
                    )}
                    onClick={() => {
                      deleteRunbook(entry.id);
                      setRunbooks(loadRunbooks());
                      if (activeId === entry.id)
                        setActiveId(null);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="forward-add"
                onClick={() =>
                  setEditing({
                    id: crypto.randomUUID(),
                    title: "",
                    commandsText: ""
                  })
                }
              >
                <PlusOutlined />{" "}
                {t("ai.runbook.new")}
              </button>
            </div>
          )}

          {/* Runbook 执行区：选中条目后显示参数输入与执行按钮 */}
          {tab === "runbook" &&
            active &&
            !editing && (
              <div className="ai-runbook-run">
                {activeParams.map(name => (
                  <input
                    key={name}
                    className="ai-multiexec-cmd"
                    value={
                      paramValues[name] ?? ""
                    }
                    onChange={event =>
                      setParamValues({
                        ...paramValues,
                        [name]: event.target.value
                      })
                    }
                    placeholder={`{{${name}}}`}
                    spellCheck={false}
                  />
                ))}
                <button
                  type="button"
                  className="ai-hostnotes-save"
                  disabled={running}
                  onClick={() =>
                    void executeRunbook(active)
                  }
                >
                  <PlayCircleOutlined />
                  {running
                    ? t("ai.multiExec.progress", {
                        done: progress.done,
                        total: progress.total
                      })
                    : t("ai.runbook.execute")}
                </button>
              </div>
            )}

          {error && (
            <p className="ai-edit-error">
              {error}
            </p>
          )}
          {tab === "multi" && (
            <div className="ai-multiexec-foot">
              <span className="ai-hostnotes-count">
                {running
                  ? t("ai.multiExec.progress", {
                      done: progress.done,
                      total: progress.total
                    })
                  : `${selected.size} ${t("ai.multiExec.selected")}`}
              </span>
              <button
                type="button"
                className="ai-hostnotes-save"
                disabled={
                  running ||
                  selected.size === 0 ||
                  !command.trim()
                }
                onClick={() => void execute()}
              >
                <ClusterOutlined />
                {confirming
                  ? t("ai.multiExec.confirm")
                  : t("ai.multiExec.run")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
