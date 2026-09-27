import {
  useCallback,
  useEffect,
  useState,
  type ReactNode
} from "react";
import {
  CloseOutlined,
  InfoCircleOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import {
  fmtBytes,
  fmtRate,
  parseSysInfo,
  SYS_SCRIPT,
  type SysInfo
} from "@/terminal/lib/sysInfo";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

type SystemInfoDrawerProps = {
  /** 采集目标的 SSH 会话。 */
  session: OpenSession;
  onClose: () => void;
};

/** 单行表格：表头 + 一行数据。 */
function SysTable({
  head,
  children
}: {
  head: string[];
  children: ReactNode;
}) {
  return (
    <div className="sys-table-wrap">
      <table className="sys-table">
        <thead>
          <tr>
            {head.map(cell => (
              <th key={cell}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 核心指标卡：标签 + 数值 + 占比 + 进度条。 */
function MetricCard({
  label,
  value,
  unit,
  pct,
  tone
}: {
  label: string;
  value: string;
  unit?: string;
  pct: number;
  tone: "cpu" | "mem" | "disk";
}) {
  return (
    <div className={`sys-card is-${tone}`}>
      <span className="sys-card-label">
        {label}
      </span>
      <div className="sys-card-row">
        <span
          className={`sys-card-value is-${tone}`}
        >
          {value}
          {unit && (
            <span className="sys-card-unit">
              {unit}
            </span>
          )}
        </span>
        <span
          className={`sys-card-pct is-${tone}`}
        >
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="sys-bar">
        <i
          className={`is-${tone}`}
          style={{
            width: `${Math.min(100, Math.max(0, pct))}%`
          }}
        />
      </div>
    </div>
  );
}

/** 分区标题 + 悬停说明小图标。 */
function SectionTitle({
  title,
  tip
}: {
  title: string;
  tip: string;
}) {
  return (
    <h4 className="sys-section">
      {title}
      <span
        className="sys-section-tip"
        title={tip}
      >
        <InfoCircleOutlined />
      </span>
    </h4>
  );
}

/**
 * 底部「系统信息」抽屉：打开时经 SSH exec 通道跑一条聚合脚本，
 * 展示核心指标、系统与 CPU / 内存 / 交换 / 网络 / 文件系统分区。
 */
export default function SystemInfoDrawer({
  session,
  onClose
}: SystemInfoDrawerProps) {
  const t = useT();
  const [info, setInfo] =
    useState<SysInfo | null>(null);
  // 挂载即开始采集，busy 初值为真；collect 内不再同步 setBusy，
  // 避免 effect 体内 setState（react-hooks 规则）
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const fetchInfo = useCallback(
    () =>
      aiRunCommand(
        {
          host: session.host,
          port: session.port,
          username: session.username,
          password: session.password
        },
        SYS_SCRIPT
      ).then(result =>
        parseSysInfo(result.stdout)
      ),
    [session]
  );

  // setState 只出现在 promise 回调里：effect 体内同步调用不会触发级联渲染
  const applyCollect = () => {
    fetchInfo()
      .then(next => {
        setInfo(next);
        setError("");
      })
      .catch(reason => {
        console.error(
          "[sys-info] 采集失败",
          reason
        );
        setError(String(reason));
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    applyCollect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载与切会话时采集
  }, [session]);

  const pct = (part: number, total: number) =>
    total > 0 ? (part / total) * 100 : 0;

  return (
    <div className="sys-drawer">
      <div className="sys-drawer-head">
        <InfoCircleOutlined className="sys-head-icon" />
        <span>{t("sys.title")}</span>
        <div className="sys-drawer-actions">
          <button
            type="button"
            className="sys-icon-btn"
            aria-label={t("sys.refresh")}
            title={t("sys.refresh")}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              applyCollect();
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
        {busy && !info && (
          <p className="sys-loading">
            {t("sys.loading")}
          </p>
        )}
        {error && (
          <p className="sys-loading is-error">
            {error}
          </p>
        )}
        {info && (
          <>
            <SectionTitle
              title={t("sys.core")}
              tip={t("sys.tip.core")}
            />
            <div className="sys-cards">
              <MetricCard
                label={t("sys.cpu")}
                value={info.cpuTotal.toFixed(1)}
                unit="%"
                pct={info.cpuTotal}
                tone="cpu"
              />
              <MetricCard
                label={t("sys.mem")}
                value={(
                  info.mem.used /
                  1024 ** 3
                ).toFixed(1)}
                unit="GB"
                pct={pct(
                  info.mem.used,
                  info.mem.total
                )}
                tone="mem"
              />
              <MetricCard
                label={t("sys.disk")}
                value={
                  info.rootDisk
                    ? (
                        info.rootDisk.used /
                        1024 ** 3
                      ).toFixed(1)
                    : "0"
                }
                unit="GB"
                pct={info.rootDisk?.pct ?? 0}
                tone="disk"
              />
            </div>

            <SectionTitle
              title={t("sys.title")}
              tip={t("sys.tip.system")}
            />
            <div className="sys-grid">
              <span>{t("sys.os")}</span>
              <dd>{info.os || "-"}</dd>
              <span>{t("sys.kernel")}</span>
              <dd>{info.kernel || "-"}</dd>
              <span>{t("sys.arch")}</span>
              <dd>{info.arch || "-"}</dd>
              <span>{t("sys.hostname")}</span>
              <dd>{info.hostname || "-"}</dd>
            </div>

            <SectionTitle
              title={t("sys.cpuInfo")}
              tip={t("sys.tip.cpuInfo")}
            />
            <SysTable
              head={[
                t("sys.colName"),
                t("sys.colCores"),
                t("sys.colFreq"),
                t("sys.colCache"),
                t("sys.colBogo")
              ]}
            >
              <tr>
                <td>
                  {info.cpu.name ||
                    t("sys.unknown")}
                </td>
                <td>{info.cpu.cores || "-"}</td>
                <td>
                  {info.cpu.mhz
                    ? `${info.cpu.mhz} MHz`
                    : t("sys.unknown")}
                </td>
                <td>
                  {info.cpu.caches.map(c => (
                    <div key={c}>{c}</div>
                  ))}
                </td>
                <td>
                  {info.cpu.bogoMips || "-"}
                </td>
              </tr>
            </SysTable>
            <SysTable
              head={[
                t("sys.uUser"),
                t("sys.uSystem"),
                t("sys.uNice"),
                t("sys.uIdle"),
                t("sys.uIo"),
                t("sys.uHardirq"),
                t("sys.uSoftirq"),
                t("sys.uSteal")
              ]}
            >
              <tr>
                <td>
                  {info.cpuUsage.user.toFixed(1)}%
                </td>
                <td>
                  {info.cpuUsage.system.toFixed(
                    1
                  )}
                  %
                </td>
                <td>
                  {info.cpuUsage.nice.toFixed(1)}%
                </td>
                <td>
                  {info.cpuUsage.idle.toFixed(1)}%
                </td>
                <td>
                  {info.cpuUsage.iowait.toFixed(
                    1
                  )}
                  %
                </td>
                <td>
                  {info.cpuUsage.irq.toFixed(1)}%
                </td>
                <td>
                  {info.cpuUsage.softirq.toFixed(
                    1
                  )}
                  %
                </td>
                <td>
                  {info.cpuUsage.steal.toFixed(1)}
                  %
                </td>
              </tr>
            </SysTable>

            <SectionTitle
              title={t("sys.memInfo")}
              tip={t("sys.tip.memInfo")}
            />
            <SysTable
              head={[
                t("sys.colTotal"),
                t("sys.colUsed"),
                t("sys.colFree"),
                t("sys.colShared"),
                t("sys.colCacheBuf"),
                t("sys.colAvail")
              ]}
            >
              <tr>
                <td>
                  {fmtBytes(info.mem.total)}
                </td>
                <td>
                  {fmtBytes(info.mem.used)}{" "}
                  {pct(
                    info.mem.used,
                    info.mem.total
                  ).toFixed(1)}
                  %
                </td>
                <td>{fmtBytes(info.mem.free)}</td>
                <td>
                  {fmtBytes(info.mem.shared)}
                </td>
                <td>
                  {fmtBytes(info.mem.cache)}
                </td>
                <td>
                  {fmtBytes(info.mem.available)}
                </td>
              </tr>
            </SysTable>

            <SectionTitle
              title={t("sys.swapInfo")}
              tip={t("sys.tip.swapInfo")}
            />
            <div className="sys-oneline">
              <span>{t("sys.swapName")}</span>
              <span>
                {t("sys.swapLine", {
                  used: fmtBytes(info.swap.used),
                  pct: `${pct(
                    info.swap.used,
                    info.swap.total
                  ).toFixed(0)}%`,
                  free: fmtBytes(info.swap.free)
                })}
              </span>
            </div>

            <SectionTitle
              title={t("sys.netInfo")}
              tip={t("sys.tip.netInfo")}
            />
            <SysTable
              head={[
                t("sys.colIfName"),
                t("sys.colRx"),
                t("sys.colRxRate"),
                t("sys.colTx"),
                t("sys.colTxRate")
              ]}
            >
              {info.net.map(nic => (
                <tr key={nic.name}>
                  <td>{nic.name}</td>
                  <td>{fmtBytes(nic.rx)}</td>
                  <td>{fmtRate(nic.rxBps)}</td>
                  <td>{fmtBytes(nic.tx)}</td>
                  <td>{fmtRate(nic.txBps)}</td>
                </tr>
              ))}
            </SysTable>

            <SectionTitle
              title={t("sys.fsInfo")}
              tip={t("sys.tip.fsInfo")}
            />
            <SysTable
              head={[
                t("sys.colName"),
                t("sys.colSize"),
                t("sys.colUsed"),
                t("sys.colAvail"),
                t("sys.colMount")
              ]}
            >
              {info.disks.map(disk => (
                <tr
                  key={`${disk.name}:${disk.mount}`}
                >
                  <td>{disk.name}</td>
                  <td>{disk.size}</td>
                  <td>
                    {disk.used} ({disk.usePct})
                  </td>
                  <td>{disk.avail}</td>
                  <td>{disk.mount}</td>
                </tr>
              ))}
            </SysTable>
          </>
        )}
      </div>
    </div>
  );
}
