/**
 * 底部信息抽屉的切换器：按 mode 渲染对应抽屉。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。各抽屉共用同一块
 * 网格行，只是内容不同；开合状态由父级的 `bottomDrawer` 状态驱动
 * （none = 收起）。
 */
import {
  CloseOutlined,
  GlobalOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import SystemInfoDrawer from "./SystemInfoDrawer";
import ProcessInfoDrawer from "./ProcessInfoDrawer";
import NetworkInfoDrawer from "./NetworkInfoDrawer";
import { CommandDrawer } from "./CommandDrawer";
import { NetDiagDrawer } from "./NetDiagDrawer";

/** 底部抽屉：none / 命令 / 网络诊断 / 系统信息 / 进程信息 / 网络信息 */
export type BottomDrawerMode =
  | "none"
  | "cmd"
  | "diag"
  | "sys"
  | "proc"
  | "net";

export function BottomDrawer({
  session,
  mode,
  onSendCommand,
  broadcastCount,
  onClose,
  closing
}: {
  /** 当前活动会话（非 SSH 会话不显示抽屉） */
  session: OpenSession | undefined;
  mode: BottomDrawerMode;
  /** 命令抽屉的发送出口（TerminalWorkspace 里统一走 terminal_write）。 */
  onSendCommand: (
    command: string,
    broadcast: boolean
  ) => number;
  /** 「发到所有」能覆盖的会话数。 */
  broadcastCount: number;
  onClose: () => void;
  /** 关闭动画播放中（内容保留，播完再卸载）。 */
  closing?: boolean;
}) {
  const t = useT();
  const render = () => {
    if (mode === "none") return null;
    // 命令抽屉对本机终端也有意义（发 dir / ipconfig），先于 SSH 判断
    if (mode === "cmd") {
      if (!session) return null;
      return (
        <CommandDrawer
          session={session}
          onSend={onSendCommand}
          broadcastCount={broadcastCount}
          onClose={onClose}
        />
      );
    }
    // 网络诊断：SSH 会话专属。本地会话也要弹——静默 null 会让
    // 「点了菜单没反应」（实测：本地会话点菜单终端缩了却什么都没有）
    if (mode === "diag") {
      if (!session) return null;
      if (session.kind !== "ssh")
        return (
          <div className="sys-drawer cmd-drawer">
            <div className="sys-drawer-head">
              <GlobalOutlined className="sys-head-icon" />
              <span>{t("diag.title")}</span>
              <div className="sys-drawer-actions">
                <button
                  type="button"
                  className="sys-icon-btn"
                  aria-label={t(
                    "app.action.close"
                  )}
                  onClick={onClose}
                >
                  <CloseOutlined />
                </button>
              </div>
            </div>
            <div className="sys-drawer-body">
              <p className="cmd-hint">
                {t("diag.sshOnly")}
              </p>
            </div>
          </div>
        );
      return (
        <NetDiagDrawer
          session={session}
          onClose={onClose}
        />
      );
    }
    if (session?.kind !== "ssh") return null;
    if (mode === "sys")
      return (
        <SystemInfoDrawer
          session={session}
          onClose={onClose}
        />
      );
    if (mode === "net")
      return (
        <NetworkInfoDrawer
          session={session}
          onClose={onClose}
        />
      );
    return (
      <ProcessInfoDrawer
        session={session}
        onClose={onClose}
      />
    );
  };
  // 关闭动画期间继续渲染内容，包一层播放滑出后由父级卸载。
  // --drawer-h = 各模式的真实高度：max-height 过渡从真实高度起算，
  // 全程可见（起算值虚高会导致前半段过渡空转、看起来没动画）
  const drawerHeights: Record<string, string> = {
    cmd: "220px",
    diag: "220px",
    sys: "360px",
    proc: "360px",
    net: "360px"
  };
  if (mode === "none" && !closing) return null;
  return (
    <div
      className={`drawer-slide${
        closing ? " is-closing" : ""
      }`}
      style={
        {
          "--drawer-h": drawerHeights[mode]
        } as React.CSSProperties
      }
    >
      {render()}
    </div>
  );
}
