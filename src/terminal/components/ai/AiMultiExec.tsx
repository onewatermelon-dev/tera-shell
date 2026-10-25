/**
 * 「多机执行」弹层：选一批 SSH 会话 → 输一条命令 → 并发执行 →
 * 结果表格发进 AI 对话流（模型续一轮汇总诊断）。
 *
 * 会话列表从落盘数据读（分组/未分组两节），连接目标现场用
 * buildSshTarget 构造（密文解密、跳板链与 SFTP 同源）。黑名单命中
 * 直接拒绝；执行按钮两击确认，防手滑对整组机器发命令。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { ClusterOutlined } from "@ant-design/icons";
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

export function AiMultiExec({
  blacklist,
  onSend
}: {
  /** 命令黑名单（与 AI 命令执行同一份） */
  blacklist: string[];
  /** 执行完成：把结果表格发进对话流 */
  onSend: (markdown: string) => void;
}) {
  const t = useT();
  // 开合状态自包含（同 AiHostNotes / AiHistoryMenu 模式）
  const [open, setOpen] = useState(false);
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
  const saved = useMemo(() => loadSessions(), []);
  // 可选目标：全部 SSH 会话（本地会话没有执行通道），按分组分节展示
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
                        {item.name || item.host}
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
          {error && (
            <p className="ai-edit-error">
              {error}
            </p>
          )}
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
        </div>
      )}
    </div>
  );
}
