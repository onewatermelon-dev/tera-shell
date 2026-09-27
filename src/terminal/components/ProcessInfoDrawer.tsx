import {
  useCallback,
  useEffect,
  useState
} from "react";
import {
  CloseOutlined,
  CopyOutlined,
  ReloadOutlined,
  ClusterOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import {
  parseProcesses,
  PROC_SCRIPT,
  type ProcInfo
} from "@/terminal/lib/sysInfo";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

/** 自动轮询间隔：抽屉打开期间每 2s 重新采集一次。 */
const PROC_REFRESH_MS = 2000;

type ProcessInfoDrawerProps = {
  /** 采集目标的 SSH 会话。 */
  session: OpenSession;
  onClose: () => void;
};

/** 排序列；pid/mem/cpu 按数值，user/cmd 按文本。 */
type ProcSortKey =
  "pid" | "user" | "mem" | "cpu" | "cmd";

/**
 * 底部「进程信息」抽屉：ps 采集当前服务器进程列表，
 * 表头点击排序（默认 PID 倒序），内存/CPU 列带占比条，
 * 每行可复制命令行。与系统信息抽屉共用 sys-drawer 样式。
 */
export default function ProcessInfoDrawer({
  session,
  onClose
}: ProcessInfoDrawerProps) {
  const t = useT();
  const [procs, setProcs] = useState<
    ProcInfo[] | null
  >(null);
  // 挂载即采集，busy 初值为真（collect 内不同步 setBusy）
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] =
    useState<ProcSortKey>("pid");
  const [sortDesc, setSortDesc] = useState(true);
  const [copiedPid, setCopiedPid] = useState<
    number | null
  >(null);

  const fetchProcs = useCallback(
    () =>
      aiRunCommand(
        {
          host: session.host,
          port: session.port,
          username: session.username,
          password: session.password
        },
        PROC_SCRIPT
      ).then(result =>
        parseProcesses(result.stdout)
      ),
    [session]
  );

  // 动态更新：立即采集一次，之后每 2s 轮询；用「完成后再排下次」的
  // setTimeout 链而非 setInterval，慢请求不会叠加重叠。
  // setState 都在 await 之后，effect 体内无同步更新
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await fetchProcs();
        if (cancelled) return;
        setProcs(next);
        setError("");
      } catch (reason) {
        if (cancelled) return;
        console.error(
          "[proc-info] 采集失败",
          reason
        );
        setError(String(reason));
      }
      if (!cancelled) {
        setBusy(false);
        timer = window.setTimeout(
          tick,
          PROC_REFRESH_MS
        );
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchProcs]);

  function toggleSort(key: ProcSortKey) {
    if (key === sortKey) {
      setSortDesc(desc => !desc);
      return;
    }
    setSortKey(key);
    // 文本列升序直观，数值列（占用）降序更有用
    setSortDesc(key === "mem" || key === "cpu");
  }

  // 复制按钮在 PID 列旁：复制的是进程 PID
  async function copyPid(proc: ProcInfo) {
    try {
      await navigator.clipboard.writeText(
        String(proc.pid)
      );
      setCopiedPid(proc.pid);
      setTimeout(() => setCopiedPid(null), 1500);
    } catch {
      /* 剪贴板不可用时静默：低频辅助操作 */
    }
  }

  const sorted = procs
    ? [...procs].sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        const cmp =
          typeof va === "number" &&
          typeof vb === "number"
            ? va - vb
            : String(va).localeCompare(
                String(vb)
              );
        return sortDesc ? -cmp : cmp;
      })
    : null;

  const arrow = (key: ProcSortKey) =>
    key === sortKey
      ? sortDesc
        ? " ↓"
        : " ↑"
      : "";

  return (
    <div className="sys-drawer">
      <div className="sys-drawer-head">
        <ClusterOutlined className="sys-head-icon" />
        <span>{t("proc.title")}</span>
        <div className="sys-drawer-actions">
          <button
            type="button"
            className="sys-icon-btn"
            aria-label={t("sys.refresh")}
            title={t("sys.refresh")}
            disabled={busy}
            onClick={() => {
              // 轮询本身 2s 一轮；按钮只是立刻催一次，不等下个周期
              fetchProcs()
                .then(next => {
                  setProcs(next);
                  setError("");
                })
                .catch(reason =>
                  setError(String(reason))
                );
            }}
          >
            <ReloadOutlined spin={busy} />
          </button>
          <button
            type="button"
            className="sys-icon-btn"
            aria-label={t("app.action.close")}
            title={t("app.action.close")}
            onClick={onClose}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
      <div className="sys-drawer-body">
        {busy && !procs && (
          <p className="sys-loading">
            {t("sys.loading")}
          </p>
        )}
        {error && (
          <p className="sys-loading is-error">
            {error}
          </p>
        )}
        {sorted && (
          <div className="sys-table-wrap">
            <table className="sys-table proc-table">
              <thead>
                <tr>
                  {(
                    [
                      ["pid", t("proc.colPid")],
                      ["user", t("proc.colUser")],
                      ["mem", t("proc.colMem")],
                      ["cpu", t("proc.colCpu")],
                      ["cmd", t("proc.colCmd")]
                    ] as [ProcSortKey, string][]
                  ).map(([key, label]) => (
                    <th
                      key={key}
                      className={`is-sortable ${
                        key === sortKey
                          ? "is-active"
                          : ""
                      }`}
                      onClick={() =>
                        toggleSort(key)
                      }
                    >
                      {label}
                      {arrow(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(proc => (
                  <tr key={proc.pid}>
                    {/* PID 后跟复制按钮：点一下把 PID 写进剪贴板 */}
                    <td className="proc-pid">
                      {proc.pid}
                      <button
                        type="button"
                        className="sys-icon-btn"
                        aria-label={t(
                          "ai.card.copy"
                        )}
                        title={t("ai.card.copy")}
                        onClick={() =>
                          void copyPid(proc)
                        }
                      >
                        {copiedPid ===
                        proc.pid ? (
                          "✓"
                        ) : (
                          <CopyOutlined />
                        )}
                      </button>
                    </td>
                    <td>{proc.user}</td>
                    <td>
                      {proc.mem.toFixed(1)}%
                      <div className="sys-bar is-mini">
                        <i
                          className="is-mem"
                          style={{
                            width: `${Math.min(100, proc.mem)}%`
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      {proc.cpu.toFixed(1)}%
                      <div className="sys-bar is-mini">
                        <i
                          className="is-cpu"
                          style={{
                            width: `${Math.min(100, proc.cpu)}%`
                          }}
                        />
                      </div>
                    </td>
                    <td className="proc-cmd">
                      <span title={proc.cmd}>
                        {proc.cmd}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
