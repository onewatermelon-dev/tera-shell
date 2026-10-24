import { logError } from "@/shared/lib/log";
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
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "@/settings/lib/i18n";
import { loadSettings } from "@/settings/lib/settings";
import { aiRunCommand } from "@/terminal/lib/ai/aiExec";
import {
  fmtBytes,
  NET_SCRIPT,
  parseNetInfo,
  type NetInfo
} from "@/terminal/lib/sysInfo";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

/** 一条活跃临时隧道（tunnel_list 的返回行）。 */
type TunnelInfo = {
  id: string;
  localPort: number;
  remotePort: number;
  target: string;
};

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
  /** 活跃的临时隧道列表（每次开新隧道 / 打开抽屉时拉取） */
  const [tunnels, setTunnels] = useState<
    TunnelInfo[]
  >([]);
  /** 正在开隧道的那一行远端端口（按钮转圈用；NetInfo.port 是 ss 解析出的字符串） */
  const [openingPort, setOpeningPort] = useState<
    string | null
  >(null);
  const [tunnelError, setTunnelError] =
    useState("");

  const refreshTunnels = useCallback(() => {
    invoke<TunnelInfo[]>("tunnel_list")
      .then(setTunnels)
      .catch(() => setTunnels([]));
  }, []);

  // 打开抽屉时拉一次隧道列表
  useEffect(refreshTunnels, [refreshTunnels]);

  /** 一键本地打开：起临时隧道 → 默认浏览器打开对应本地地址。 */
  async function openTunnel(row: NetInfo) {
    setOpeningPort(row.port);
    setTunnelError("");
    try {
      // ⚠️ 只传连接字段，绝不能整个 session 传 —— OpenSession 带着
      // xterm 的 terminal 实例（循环引用），invoke 序列化直接炸
      const {
        sshKeyPath,
        useSshConfig,
        hostKeyPolicy
      } = loadSettings();
      const tunnel = await invoke<TunnelInfo>(
        "tunnel_open",
        {
          config: {
            id: `tunnel-${session.id}`,
            kind: session.kind,
            host: session.host,
            port: session.port,
            username: session.username,
            password: session.password,
            sshKeyPath,
            useSshConfig,
            hostKeyPolicy
          },
          remotePort: Number(row.port),
          // 转发目标用该行的监听 IP：服务可能只绑在网卡 IP 上，
          // 硬编码 localhost 会「拒绝连接」（通配地址由后端归一）
          targetHost: row.ip
        }
      );
      refreshTunnels();
      // 只对 HTTP 端口开浏览器没有判断依据 —— 统一开
      // http://localhost:port，非 Web 服务由浏览器自然显示连接失败
      await openUrl(
        `http://localhost:${tunnel.localPort}`
      );
    } catch (reason) {
      logError("[tunnel] 开启失败", reason);
      setTunnelError(String(reason));
    } finally {
      setOpeningPort(null);
    }
  }

  async function closeTunnel(id: string) {
    try {
      await invoke("tunnel_close", { id });
    } catch (reason) {
      logError("[tunnel] 关闭失败", reason);
    }
    refreshTunnels();
  }

  const fetchNet = useCallback(
    () =>
      aiRunCommand(
        session.execTarget,
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
        logError("[net-info] 采集失败", reason);
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
        {tunnelError && (
          <p className="sys-loading is-error">
            {tunnelError}
          </p>
        )}
        {tunnels.length > 0 && (
          <div className="tunnel-list">
            {tunnels.map(tunnel => (
              <div
                className="tunnel-row"
                key={tunnel.id}
              >
                <span className="tunnel-mapping">
                  localhost:
                  {tunnel.localPort} →{" "}
                  {tunnel.target.split("@")[1]}:
                  {tunnel.remotePort}
                </span>
                <button
                  type="button"
                  className="sys-icon-btn"
                  aria-label={t(
                    "net.tunnelClose"
                  )}
                  title={t("net.tunnelClose")}
                  onClick={() =>
                    void closeTunnel(tunnel.id)
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
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
                    <td className="tunnel-cell">
                      {row.port}
                      {/* 一键本地打开：监听端口 → 临时隧道 → 浏览器 */}
                      <button
                        type="button"
                        className="sys-icon-btn"
                        aria-label={t(
                          "net.openLocal"
                        )}
                        title={t("net.openLocal")}
                        disabled={
                          openingPort !== null
                        }
                        onClick={() =>
                          void openTunnel(row)
                        }
                      >
                        {openingPort ===
                        row.port ? (
                          <ReloadOutlined className="net-spinning" />
                        ) : (
                          "↗"
                        )}
                      </button>
                    </td>
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
