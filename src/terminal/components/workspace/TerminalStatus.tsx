/**
 * 底部状态栏：快捷宏 ⇆ 系统信息（竖条按钮切换）。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。只在有活动的 SSH
 * 会话时显示：本地会话用不到快捷宏与系统信息，没有任何会话时更
 * 不该挂着一条空栏。
 */
import MacroBar from "@/terminal/components/macro/MacroBar";
import StatusInfoBar from "@/terminal/components/StatusInfoBar";
import type { BottomDrawerMode } from "@/terminal/components/drawers/BottomDrawer";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import type { StatusMode } from "@/settings/lib/settings";
import type { TerminalMacro } from "@/terminal/lib/macro/terminalMacros";

export function TerminalStatus({
  active,
  statusMode,
  macros,
  disconnected,
  macroTargetId,
  onRunMacro,
  onBroadcastMacro,
  broadcastCount,
  onAddMacro,
  onEditMacro,
  onDeleteMacro,
  onReorderMacro,
  onNotify,
  bottomDrawer,
  onOpenDrawer
}: {
  active: OpenSession | undefined;
  /** 底部状态栏形态：快捷宏 ⇆ 系统信息（竖条按钮切换）。 */
  statusMode: StatusMode;
  /** 快捷宏列表。 */
  macros: TerminalMacro[];
  /** 断线状态：宏按钮对断线会话置灰。 */
  disconnected: Record<string, boolean>;
  /** 宏执行目标 = 活动窗格正在显示的那只。 */
  macroTargetId?: string;
  onRunMacro: (
    macro: TerminalMacro,
    targetId: string
  ) => void;
  /** 右键菜单 → 发送到所有已打开的会话标签。 */
  onBroadcastMacro: (
    macro: TerminalMacro
  ) => void;
  /** 「发送到所有标签」会落到的会话数；0 时菜单里该项置灰。 */
  broadcastCount: number;
  onAddMacro: () => void;
  onEditMacro: (macro: TerminalMacro) => void;
  onDeleteMacro: (macro: TerminalMacro) => void;
  onReorderMacro: (
    id: string,
    beforeId: string | null
  ) => void;
  /** 信息形态下点击未开放入口（系统 / 进程 / 网络信息）的提示出口。 */
  onNotify: (message: string) => void;
  /** 当前打开的抽屉（决定信息入口的选中态）。 */
  bottomDrawer: BottomDrawerMode;
  onOpenDrawer: (mode: BottomDrawerMode) => void;
}) {
  if (!active || active.kind === "local")
    return null;
  return (
    <div className="terminal-status">
      {statusMode === "info" ? (
        // 信息形态：左侧信息入口 + 右侧负载 / 网络，整组替换宏与 LOCAL/UTF-8
        <StatusInfoBar
          session={active}
          onNotify={onNotify}
          onOpenSystem={() => onOpenDrawer("sys")}
          onOpenProcess={() =>
            onOpenDrawer("proc")
          }
          onOpenNetwork={() =>
            onOpenDrawer("net")
          }
          activeEntry={
            bottomDrawer === "sys"
              ? "system"
              : bottomDrawer === "proc"
                ? "process"
                : bottomDrawer === "net"
                  ? "network"
                  : undefined
          }
        />
      ) : (
        <>
          {/* 快捷宏挤在状态栏最前面：常驻可见，又不单独占一行 */}
          <MacroBar
            macros={macros}
            disabled={
              !macroTargetId ||
              disconnected[macroTargetId] === true
            }
            onRun={macro => {
              if (macroTargetId)
                onRunMacro(macro, macroTargetId);
            }}
            onBroadcast={onBroadcastMacro}
            broadcastCount={broadcastCount}
            onAdd={onAddMacro}
            onEdit={onEditMacro}
            onDelete={onDeleteMacro}
            onReorder={onReorderMacro}
          />
          {/* 状态文字单独成组并禁止收缩：宏再多也不会被顶出可视区 */}
          <div className="status-meta">
            <span>SSH</span>
            <span>UTF-8</span>
            <span>
              {active.terminal.cols || 0} ×{" "}
              {active.terminal.rows || 0}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
