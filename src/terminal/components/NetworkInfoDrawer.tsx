import {
  useCallback,
  useEffect,
  useState
} from "react";
import {
  CloseOutlined,
  CopyOutlined,
  ReloadOutlined,
  WifiOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import {
  fmtBytes,
  NET_SCRIPT,
  parseNetInfo,
  type NetInfo
} from "@/terminal/lib/sysInfo";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

/** 自动轮询间隔：抽屉打开期间每 2s 重新采集一次。 */
const NET_REFRESH_MS = 2000;

type NetworkInfoDrawerProps = {
  /** 采集目标的 SSH 会话。 */
  session: OpenSession;
  onClose: () => void;
};

/** 排序列；port/ipCount/connCount/recv/send 按数值，其余按文本。 */
type NetSortKey =
  | "pid"
  | "name"
  | "ip"
  | "port"
  | "ipCount"
  | "connCount"
  | "recv"
  | "send";

/**
 * 底部「网络信息」抽屉：ss 采集监听套接字与连接，
 * 表头点击排序（默认 PID 倒序），PID 旁可复制，2s 轮询刷新。
 * 与系统 / 进程抽屉共用 sys-drawer 样式。
 */
export default function NetworkInfoDrawer({
  session,
  onClose
}: NetworkInfoDrawerProps) {
  const t = useT();
  const [rows, setRows] = useState<
    NetInfo[] | null
  >(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] =
    useState<NetSortKey>("pid");
  const [sortDesc, setSortDesc] = useState(true);
  const [copiedPid, setCopiedPid] = useState<
    number | null
  >(null);

  const fetchNet = useCallback(
    () =>
      aiRunCommand(
        {
          host: session.host,
          port: session.port,
          username: session.username,
          password: session.password
        },
        NET_SCRIPT
      ).then(result =>
        parseNetInfo(result.stdout)
      ),
    [session]
  );

  // 立即采集 + 完成后再排下次的 2s 轮询链，关闭即停
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await fetchNet();
        if (cancelled) return;
        setRows(next);
        setError("");
      } catch (reason) {
        if (cancelled) return;
        console.error(
          "[net-info] 采集失败",
          reason
        );
        setError(String(reason));
      }
      if (!cancelled) {
        setBusy(false);
        timer = window.setTimeout(
          tick,
          NET_REFRESH_MS
        );
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchNet]);

  function toggleSort(key: NetSortKey) {
    if (key === sortKey) {
      setSortDesc(desc => !desc);
      return;
    }
    setSortKey(key);
    setSortDesc(
      key === "pid" ||
        key === "ipCount" ||
        key === "connCount" ||
        key === "recv" ||
        key === "send"
    );
  }

  // 复制按钮在 PID 旁：复制进程 PID
  async function copyPid(row: NetInfo) {
    try {
      await navigator.clipboard.writeText(
        String(row.pid)
      );
      setCopiedPid(row.pid);
      setTimeout(() => setCopiedPid(null), 1500);
    } catch {
      /* 剪贴板不可用时静默：低频辅助操作 */
    }
  }

  const sorted = rows
    ? [...rows].sort((a, b) => {
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

  const arrow = (key: NetSortKey) =>
    key === sortKey
      ? sortDesc
        ? " ↓"
        : " ↑"
      : "";

  const heads: [NetSortKey, string][] = [
    ["pid", t("proc.colPid")],
    ["name", t("net.colName")],
    ["ip", t("net.colIp")],
    ["port", t("net.colPort")],
    ["ipCount", t("net.colIpCount")],
    ["connCount", t("net.colConn")],
    ["recv", t("net.colRecv")],
    ["send", t("net.colSend")]
  ];

  return (
    <div className="sys-drawer">
      <div className="sys-drawer-head">
        <WifiOutlined className="sys-head-icon" />
        <span>{t("net.title")}</span>
        <div className="sys-drawer-actions">
          <button
            type="button"
            className="sys-icon-btn"
            aria-label={t("sys.refresh")}
            title={t("sys.refresh")}
            disabled={busy}
            onClick={() => {
              fetchNet()
                .then(next => {
                  setRows(next);
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
        {busy && !rows && (
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
                  {heads.map(([key, label]) => (
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
                {sorted.map((row, index) => (
                  <tr
                    key={`${row.pid}:${row.ip}:${row.port}:${index}`}
                  >
                    <td className="proc-pid">
                      {row.pid || "-"}
                      {row.pid > 0 && (
                        <button
                          type="button"
                          className="sys-icon-btn"
                          aria-label={t(
                            "ai.card.copy"
                          )}
                          title={t(
                            "ai.card.copy"
                          )}
                          onClick={() =>
                            void copyPid(row)
                          }
                        >
                          {copiedPid ===
                          row.pid ? (
                            "✓"
                          ) : (
                            <CopyOutlined />
                          )}
                        </button>
                      )}
                    </td>
                    <td>{row.name}</td>
                    <td>{row.ip}</td>
                    <td>{row.port}</td>
                    <td>{row.ipCount}</td>
                    <td>{row.connCount}</td>
                    <td>{fmtBytes(row.recv)}</td>
                    <td>{fmtBytes(row.send)}</td>
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
