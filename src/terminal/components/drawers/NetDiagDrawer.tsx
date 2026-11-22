/**
 * 网络诊断工具箱抽屉：对当前 SSH 会话的主机做网络诊断。
 *
 * 五个工具（ping / 端口探测 / DNS / 路由 / HTTP），目标在本地校验后
 * 拼成远端命令，经 `ai_run_command` 的独立 exec 通道执行——输出不
 * 污染终端、不进命令历史。结果可一键交给 AI 面板解读。
 *
 * ## 目标校验（trust boundary）
 *
 * 目标字符串会拼进 shell 命令，必须先过白名单：
 * - 主机类（ping/dns/trace）：字母数字与 `._-`
 * - 端口探测：`主机:端口`，端口为 1-65535 数字
 * - URL：仅 http(s)，字符限 `:/?=&%._-~` 加字母数字
 * 不合格直接拒绝执行，防注入。
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CloseOutlined,
  GlobalOutlined
} from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import { useT } from "@/settings/lib/i18n";
import { aiRunCommand } from "@/terminal/lib/ai/aiExec";
import {
  askAiFromTerminal,
  hasAiAskListener
} from "@/terminal/lib/ai/askFromTerminal";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

export const DIAG_TOOLS = [
  "ping",
  "port",
  "dns",
  "trace",
  "curl"
] as const;

export type DiagTool =
  (typeof DIAG_TOOLS)[number];

/** 主机类目标：域名 / IPv4（不含端口）。 */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** URL：仅 http(s)。字符白名单刻意排除单引号/反斜杠/控制符——
 * 目标会包进 shell 单引号串，这几类字符会破坏引号边界。 */
const URL_RE =
  /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!&*+,;=%-]+$/i;

/**
 * 按工具构造远端诊断命令；目标非法返回 null（防注入）。
 * 统一包 timeout：诊断命令不允许挂死 exec 通道。
 */
export function buildDiagCommand(
  tool: DiagTool,
  target: string
): string | null {
  const value = target.trim();
  if (!value) return null;
  if (tool === "curl") {
    // 裸域名自动补 https://
    const url = /^https?:\/\//i.test(value)
      ? value
      : `https://${value}`;
    if (!URL_RE.test(url)) return null;
    // host 段必须是合法主机名/IP（拒绝 .. 穿越之类的畸形目标）
    const hostPart = url
      .slice(url.indexOf("://") + 3)
      .split(/[/?#]/)[0]!;
    if (!HOST_RE.test(hostPart)) return null;
    // 单引号包裹 URL：shell 语义下 &/$/| 等全部字面化，杜绝注入
    return `timeout 20 curl -sSI -m 15 -L '${url}'`;
  }
  switch (tool) {
    case "ping":
      if (!HOST_RE.test(value)) return null;
      return `timeout 15 ping -c 4 -W 2 ${value}`;
    case "dns":
      // getent 走系统解析器（兼容无 nslookup/dig 的精简系统）
      if (!HOST_RE.test(value)) return null;
      return `timeout 10 getent hosts ${value} || timeout 10 nslookup ${value}`;
    case "trace":
      // traceroute 常缺装，tracepath 是 iproute2 自带的兜底
      if (!HOST_RE.test(value)) return null;
      return `timeout 30 traceroute -n -m 15 -w 2 ${value} 2>/dev/null || timeout 30 tracepath -m 15 ${value}`;
    case "port": {
      // host:port 拆分在先，再分别校验（整值校验会把冒号拦掉）
      const at = value.lastIndexOf(":");
      if (at <= 0) return null;
      const host = value.slice(0, at);
      const port = value.slice(at + 1);
      if (!HOST_RE.test(host)) return null;
      if (!/^\d{1,5}$/.test(port)) return null;
      const portNum = Number(port);
      if (portNum < 1 || portNum > 65535)
        return null;
      // nc 不一定装：bash 内建 /dev/tcp 通用探测
      return `timeout 8 bash -c 'cat < /dev/null > /dev/tcp/${host}/${port}' && echo "端口 ${port} 开放" || echo "端口 ${port} 不通/被拒"`;
    }
    default:
      return null;
  }
}

type NetDiagDrawerProps = {
  /** 诊断的执行目标 = 当前 SSH 会话。 */
  session: OpenSession;
  onClose: () => void;
};

export function NetDiagDrawer({
  session,
  onClose
}: NetDiagDrawerProps) {
  const t = useT();
  const [tool, setTool] =
    useState<DiagTool>("ping");
  const [target, setTarget] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [hint, setHint] = useState("");
  /** 运行中的 execId：再点一次 = 取消。 */
  const [runId, setRunId] = useState("");

  const run = async () => {
    const command = buildDiagCommand(
      tool,
      target
    );
    if (!command) {
      setHint(t("diag.badTarget"));
      return;
    }
    if (running) {
      // 运行中再点 = 取消当前诊断
      await invoke("ai_exec_cancel", {
        execId: runId
      }).catch(() => {});
      setRunning(false);
      setHint(t("diag.cancelled"));
      return;
    }
    const execId = `diag-${Date.now()}`;
    setRunId(execId);
    setRunning(true);
    setHint("");
    setOutput("");
    try {
      const result = await aiRunCommand(
        session.execTarget,
        command,
        undefined,
        execId
      );
      setOutput(
        [
          `$ ${command.split(" ").slice(0, 2).join(" ")} …`,
          result.stdout,
          result.stderr
        ]
          .filter(Boolean)
          .join("\n") || t("diag.empty")
      );
    } catch (reason) {
      setOutput(
        `${t("diag.failed")}: ${String(reason)}`
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="sys-drawer cmd-drawer net-diag-drawer">
      <div className="sys-drawer-head">
        <GlobalOutlined className="sys-head-icon" />
        <span>{t("diag.title")}</span>
        <small className="cmd-session">
          {session.name}
        </small>
        <div className="sys-drawer-actions">
          <button
            type="button"
            className="sys-icon-btn"
            aria-label={t("app.action.close")}
            onClick={onClose}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
      <div className="sys-drawer-body netdiag-body">
        {/* 工具选择 */}
        <div className="netdiag-tools">
          {DIAG_TOOLS.map(item => (
            <Hint
              key={item}
              label={t(`diag.tool.${item}`)}
            >
              <button
                type="button"
                className={`netdiag-tool${
                  tool === item
                    ? " is-active"
                    : ""
                }`}
                onClick={() => {
                  // 切工具即换语义：上一工具的结果/提示不再适用，清空
                  setTool(item);
                  setOutput("");
                  setHint("");
                }}
              >
                {t(`diag.tool.${item}`)}
              </button>
            </Hint>
          ))}
        </div>
        {/* 目标 + 执行 */}
        <div className="netdiag-run-row">
          <input
            className="netdiag-target"
            value={target}
            placeholder={t(`diag.ph.${tool}`)}
            onChange={event => {
              setTarget(event.target.value);
              setHint("");
            }}
            onKeyDown={event => {
              if (event.key === "Enter")
                void run();
            }}
          />
          <button
            type="button"
            className="cmd-send"
            disabled={!target.trim() && !running}
            onClick={() => void run()}
          >
            {running
              ? t("diag.cancel")
              : t("diag.run")}
          </button>
          {/* AI 解读：有输出且有面板在听时出现在执行按钮旁 */}
          {output && hasAiAskListener() && (
            <Hint label={t("diag.ai")}>
              <button
                type="button"
                className="netdiag-ai-btn"
                onClick={() =>
                  askAiFromTerminal(
                    "diagnose",
                    `${t("diag.title")}（${t(
                      `diag.tool.${tool}`
                    )} → ${target}）：
${output.slice(0, 4000)}`
                  )
                }
              >
                {t("diag.ai")}
              </button>
            </Hint>
          )}
          <span className="cmd-hint">{hint}</span>
        </div>
        {/* 结果：等宽原样输出 */}
        <pre className="netdiag-out">
          {output ||
            (running
              ? t("diag.running")
              : t("diag.idle"))}
        </pre>
      </div>
    </div>
  );
}
