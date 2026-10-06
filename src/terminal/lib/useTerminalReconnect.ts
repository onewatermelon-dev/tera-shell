import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { useT } from "@/settings/lib/i18n";
import type { OpenSession } from "@/terminal/lib/terminalTypes";
import {
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelay,
  shouldAutoReconnect
} from "@/terminal/lib/reconnect";

type ReconnectState = {
  /** 已经安排了（或正在进行的）第几次重连 */
  attempts: number;
  /** 待执行的退避定时器；为空表示当前没有等待中的重连 */
  timer: ReturnType<typeof setTimeout> | null;
};

type ReconnectOptions = {
  /** 已打开的会话列表（按 id 找会话、判断标签是否已被关掉） */
  openedRef: RefObject<OpenSession[]>;
  /** 断连标记：重连成功要复位，同时同步给 ref 供闭包读取 */
  disconnectedRef: RefObject<
    Record<string, boolean>
  >;
  setDisconnected: Dispatch<
    SetStateAction<Record<string, boolean>>
  >;
  /** 重连成功后恢复的光标闪烁设置（断连时被强制关掉） */
  cursorBlink: boolean;
  onError: (reason: unknown) => void;
};

/**
 * 终端断线自动重连。
 *
 * 只在「SSH 会话 + ssh 以 255 退出」时动手（见 reconnect.ts 的判定），
 * 按退避重试有限次；重连复用**同一个 id** 调 terminal_start，后端会取代
 * 旧 PTY 并静默收尾，新输出继续写进同一个 xterm —— 历史输出、滚动位置
 * 都保留，比新开标签体验好得多。
 *
 * 复用的两个既有机制：
 * ① 同 id 重复 start 取代旧会话（后端已用 exited 标记防误报退出）；
 * ② 断连时置位的 disconnected 标记，重连成功后复位。
 */
export function useTerminalReconnect({
  openedRef,
  disconnectedRef,
  setDisconnected,
  cursorBlink,
  onError
}: ReconnectOptions) {
  const t = useT();
  /** 每个会话各自的重试计数与定时器（key = 会话 id） */
  const states = useRef(
    new Map<string, ReconnectState>()
  );

  /** 往终端里写一行灰色系统提示（与 [会话已结束] 同一视觉）。 */
  const notice = useCallback(
    (terminal: Terminal, text: string) => {
      terminal.write(
        `\r\n\x1b[38;5;244m[${text}]\x1b[0m\r\n`
      );
    },
    []
  );

  /** 立刻发起一次重连；成功即复位断连状态。 */
  const performReconnect = useCallback(
    async (
      session: OpenSession,
      attempt: number
    ) => {
      // 等待退避期间用户可能已经关掉了标签
      if (!openedRef.current.includes(session))
        return;
      console.info(
        `[terminal] 正在重连 ${session.id}（第 ${attempt}/${MAX_RECONNECT_ATTEMPTS} 次）`
      );
      notice(
        session.terminal,
        t("terminal.reconnect.trying", {
          attempt,
          max: MAX_RECONNECT_ATTEMPTS
        })
      );
      try {
        // 只送会话定义字段：运行时字段（terminal/element 等）后端不认
        await invoke("terminal_start", {
          config: {
            id: session.id,
            kind: session.kind,
            host: session.host,
            port: session.port,
            username: session.username,
            password: session.password,
            rows: session.terminal.rows,
            cols: session.terminal.cols
          }
        });
        // 断连标记复位：状态点转回、宏区与键盘输入重新放行
        setDisconnected(prev => {
          const next = { ...prev };
          delete next[session.id];
          disconnectedRef.current = next;
          return next;
        });
        // 断连时被强制关掉的闪烁恢复成设置里的值
        session.terminal.options.cursorBlink =
          cursorBlink;
        states.current.delete(session.id);
        console.info(
          `[terminal] 重连指令已下发 ${session.id}`
        );
      } catch (reason) {
        // 后端连 PTY 都没起起来（极少见）：再退避重试也没意义，
        // 交回手动入口，避免用户对着一个永远不会好的倒计时等
        console.error(
          `[terminal] 重连失败 ${session.id}`,
          reason
        );
        states.current.delete(session.id);
        notice(
          session.terminal,
          t("terminal.reconnect.giveUp")
        );
        onError(reason);
      }
    },
    [
      cursorBlink,
      disconnectedRef,
      notice,
      onError,
      openedRef,
      setDisconnected,
      t
    ]
  );

  /**
   * 安排下一次自动重连（退避 + 次数上限）。
   *
   * 同一个会话已有等待中的定时器时直接忽略：一次断开可能收到多条退出
   * 事件，不拦住会把重试次数白白吃掉。
   */
  const scheduleReconnect = useCallback(
    (session: OpenSession) => {
      const state = states.current.get(
        session.id
      ) ?? { attempts: 0, timer: null };
      if (state.timer) return;
      state.attempts += 1;
      if (
        state.attempts > MAX_RECONNECT_ATTEMPTS
      ) {
        states.current.delete(session.id);
        console.warn(
          `[terminal] 自动重连已达上限 ${session.id}`
        );
        notice(
          session.terminal,
          t("terminal.reconnect.giveUp")
        );
        return;
      }
      states.current.set(session.id, state);
      const delay = reconnectDelay(
        state.attempts
      );
      notice(
        session.terminal,
        t("terminal.reconnect.pending", {
          delay: Math.round(delay / 1000),
          attempt: state.attempts,
          max: MAX_RECONNECT_ATTEMPTS
        })
      );
      state.timer = setTimeout(() => {
        state.timer = null;
        void performReconnect(
          session,
          state.attempts
        );
      }, delay);
    },
    [notice, performReconnect, t]
  );

  /** 收到 terminal-exit 后调用：按策略决定要不要重连。 */
  const handleDisconnect = useCallback(
    (
      session: OpenSession | undefined,
      code: number | null | undefined
    ) => {
      if (!session) return;
      if (
        !shouldAutoReconnect(session.kind, code)
      ) {
        console.debug(
          `[terminal] 不重连 ${session.id}（kind=${session.kind} code=${String(code)}）`
        );
        return;
      }
      scheduleReconnect(session);
    },
    [scheduleReconnect]
  );

  /** 手动重连（右键菜单）：清掉退避计数，立刻来一次。 */
  const reconnect = useCallback(
    (id: string) => {
      const session = openedRef.current.find(
        s => s.id === id
      );
      if (!session) return;
      console.info(`[terminal] 手动重连 ${id}`);
      const state = states.current.get(id);
      if (state?.timer) clearTimeout(state.timer);
      states.current.delete(id);
      void performReconnect(session, 1);
    },
    [openedRef, performReconnect]
  );

  /** 取消某个会话的待执行重连（关闭标签时调用）。 */
  const cancelReconnect = useCallback(
    (id: string) => {
      const state = states.current.get(id);
      if (state?.timer) clearTimeout(state.timer);
      states.current.delete(id);
    },
    []
  );

  /** 取消全部待执行重连（组件卸载时调用）。 */
  const cancelAllReconnects = useCallback(() => {
    states.current.forEach(state => {
      if (state.timer) clearTimeout(state.timer);
    });
    states.current.clear();
  }, []);

  return {
    handleDisconnect,
    reconnect,
    cancelReconnect,
    cancelAllReconnects
  };
}
