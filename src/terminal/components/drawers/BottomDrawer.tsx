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

/** 底部抽屉：none / 系统信息 / 进程信息 / 网络信息 */
export type BottomDrawerMode =
  "none" | "sys" | "proc" | "net";

export function BottomDrawer({
  session,
  mode,
  onClose
}: {
  /** 当前活动会话（非 SSH 会话不显示抽屉） */
  session: OpenSession | undefined;
  mode: BottomDrawerMode;
  onClose: () => void;
}) {
  if (mode === "none") return null;
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
