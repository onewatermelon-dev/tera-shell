/**
 * 底部信息抽屉的切换器：按 mode 渲染对应抽屉。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。三个抽屉（系统 /
 * 进程 / 网络）共用同一块网格行，只是内容不同；开合状态由父级的
 * `bottomDrawer` 状态驱动（none = 收起）。
 */
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import SystemInfoDrawer from "./SystemInfoDrawer";
import ProcessInfoDrawer from "./ProcessInfoDrawer";
import NetworkInfoDrawer from "./NetworkInfoDrawer";
import { CommandDrawer } from "./CommandDrawer";

/** 底部抽屉：none / 命令 / 系统信息 / 进程信息 / 网络信息 */
export type BottomDrawerMode =
  "none" | "cmd" | "sys" | "proc" | "net";

export function BottomDrawer({
  session,
  mode,
  onSendCommand,
  broadcastCount,
  onClose
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
}) {
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
}
