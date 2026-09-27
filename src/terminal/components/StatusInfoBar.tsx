import { useEffect, useState } from "react";
import {
  InfoCircleOutlined,
  ClusterOutlined,
  WifiOutlined,
  ClockCircleOutlined,
  DashboardOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import { aiRunCommand } from "@/terminal/lib/aiExec";
import {
  fmtShort,
  fmtUptime,
  parseStatusSample,
  STATUS_SCRIPT,
  type StatusSample
} from "@/terminal/lib/sysInfo";
import type { OpenSession } from "@/terminal/lib/terminalTypes";

type StatusInfoBarProps = {
  /** 采集数据来源的 SSH 会话；省略时各项显示占位符。 */
  session?: OpenSession;
  /** 点击尚未实现的入口时的提示出口。 */
  onNotify: (message: string) => void;
  /** 打开「系统信息」抽屉；仅 SSH 会话激活时提供，否则退化为提示。 */
  onOpenSystem?: () => void;
  /** 打开「进程信息」抽屉；仅 SSH 会话激活时提供，否则退化为提示。 */
  onOpenProcess?: () => void;
  /** 打开「网络信息」抽屉；仅 SSH 会话激活时提供，否则退化为提示。 */
  onOpenNetwork?: () => void;
  /** 当前打开的抽屉对应的入口，按钮显示选中态。 */
  activeEntry?: "system" | "process" | "network";
};

/** 状态栏轮询间隔：脚本自带 1s 采样，5s 一轮足够新鲜又不扰远端。 */
const STATUS_REFRESH_MS = 5000;

/**
 * 底部状态栏的「信息」形态：左侧是系统 / 进程 / 网络信息入口与运行时长，
 * 右侧的负载、网络速度取代宏形态下的 LOCAL / UTF-8 / 尺寸。
 *
 * 数据来自 SSH exec 通道的低频轮询（负载 / 运行时长 / 收发速率）；
 * 无会话（如空状态）时各项显示 --。
 */
export default function StatusInfoBar({
  session,
  onNotify,
  onOpenSystem,
  onOpenProcess,
  onOpenNetwork,
  activeEntry
}: StatusInfoBarProps) {
  const t = useT();
  const [sample, setSample] =
    useState<StatusSample | null>(null);
  const pending = [
    "status.info.system",
    "status.info.process",
    "status.info.network"
  ] as const;

  // 完成后再排下次的轮询链；组件随形态/会话卸载即停
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await aiRunCommand(
          {
            host: session.host,
            port: session.port,
            username: session.username,
            password: session.password
          },
          STATUS_SCRIPT
        );
        if (cancelled) return;
        setSample(
          parseStatusSample(result.stdout)
        );
      } catch (reason) {
        // 轮询失败静默保留旧值：状态栏是次要展示，不打扰用户
        if (!cancelled)
          console.warn(
            "[status] 采集失败",
            reason
          );
      }
      if (!cancelled)
        timer = window.setTimeout(
          tick,
          STATUS_REFRESH_MS
        );
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session]);

  return (
    <>
      <div className="status-info">
        {pending.map(key => (
          <button
            key={key}
            type="button"
            className={`status-info-btn ${
              activeEntry &&
              key === `status.info.${activeEntry}`
                ? "is-active"
                : ""
            }`}
            onClick={() => {
              if (
                key === "status.info.system" &&
                onOpenSystem
              ) {
                onOpenSystem();
                return;
              }
              if (
                key === "status.info.process" &&
                onOpenProcess
              ) {
                onOpenProcess();
                return;
              }
              if (
                key === "status.info.network" &&
                onOpenNetwork
              ) {
                onOpenNetwork();
                return;
              }
              onNotify(t("status.notReady"));
            }}
          >
            {key === "status.info.system" && (
              <InfoCircleOutlined />
            )}
            {key === "status.info.process" && (
              <ClusterOutlined />
            )}
            {key === "status.info.network" && (
              <WifiOutlined />
            )}
            {t(key)}
          </button>
        ))}
        <span className="status-info-btn is-static">
          <ClockCircleOutlined className="status-icon is-blue" />
          {t("status.info.run")}:{" "}
          {sample
            ? fmtUptime(sample.uptimeSec)
            : "--"}
        </span>
      </div>
      <div className="status-meta">
        <span>
          <DashboardOutlined className="status-icon is-green" />
          {t("status.info.load")}:{" "}
          <span className="status-val is-green">
            {sample?.load || "-- / -- / --"}
          </span>
        </span>
        <span>
          <WifiOutlined className="status-icon is-blue" />
          {t("status.info.net")}:{" "}
          <span className="status-val is-down">
            ↓
            {sample
              ? fmtShort(sample.rxBps)
              : "--"}
          </span>
          /
          <span className="status-val is-up">
            ↑
            {sample
              ? fmtShort(sample.txBps)
              : "--"}
          </span>
        </span>
      </div>
    </>
  );
}
