/**
 * 会话生命周期：开会话（open/startSession）、密码补验、复制与命名。
 *
 * 从 useTerminals 搬出（2026-10-14 拆分）。本模块不持有终端实例的组装
 * （createTerminal 由门面注入，它依赖 appearance/搜索/右键菜单等编排
 * 状态），只负责「把一个 SavedSession 变成一只跑起来的终端」的流程：
 * 挂载 → 等尺寸稳定 → 起 PTY → 记同步尺寸，以及这中间失败的回收。
 *
 * ⚠️ startSession 里「先等尺寸稳定再起 PTY」的顺序不能改：PTY 直接按
 * 最终尺寸出生，首帧才不会触发 ConPTY 整屏重绘（会抹掉欢迎横幅、堆出
 * 重复提示符）。
 */
import {
  useCallback,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import { resolveJumpChain } from "@/sessions/lib/jumpHost";
import {
  buildSshTarget,
  type SshTarget
} from "@/sessions/lib/sshTarget";
import type { OpenSession } from "./terminalTypes";
import type { PaneState } from "./paneGrid";
import { waitForStableSize } from "./ptyResize";
import { ensureShellIntegration } from "@/terminal/lib/shellIntegration/deploy";

export function useTerminalSessions(options: {
  /** 终端实例组装（门面持有：依赖 appearance/搜索/菜单等） */
  createTerminal: (
    session: SavedSession,
    sourceSessionId: string,
    execTarget: SshTarget
  ) => OpenSession;
  setOpened: Dispatch<
    SetStateAction<OpenSession[]>
  >;
  openedRef: RefObject<OpenSession[]>;
  setDisconnected: Dispatch<
    SetStateAction<Record<string, boolean>>
  >;
  disconnectedRef: RefObject<
    Record<string, boolean>
  >;
  activePaneRef: RefObject<PaneState | undefined>;
  panesRef: RefObject<PaneState[]>;
  setPanes: Dispatch<SetStateAction<PaneState[]>>;
  /** 切到某只会话（已打开时 open 走它） */
  activateTab: (id: string) => void;
  /** 已同步给 PTY 的尺寸表：PTY 出生时把自己的尺寸写进去 */
  syncedSizes: RefObject<Map<string, string>>;
  schedulePtyResize: (
    session: OpenSession
  ) => void;
  onError: (reason: unknown) => void;
  onSavePassword:
    | ((
        sourceSessionId: string,
        encrypted: string
      ) => void)
    | undefined;
  /** 默认私钥路径（全局设置，传给 ssh 的 -i）；空串不传 */
  sshKeyPath: string;
  /** 是否读 ~/.ssh/config（关掉时后端传 -F） */
  useSshConfig: boolean;
  /** 主机密钥策略（StrictHostKeyChecking 三档） */
  hostKeyPolicy: string;
  /** 全部已保存会话：解析跳板链用（见 jumpHost.ts） */
  sessions: SavedSession[];
}) {
  const {
    createTerminal,
    setOpened,
    openedRef,
    setDisconnected,
    disconnectedRef,
    activePaneRef,
    panesRef,
    setPanes,
    activateTab,
    syncedSizes,
    schedulePtyResize,
    onError,
    onSavePassword,
    sshKeyPath,
    useSshConfig,
    hostKeyPolicy,
    sessions
  } = options;

  const [passwordRequest, setPasswordRequest] =
    useState<{
      session: SavedSession;
      sourceSessionId: string;
    } | null>(null);

  const cancelPassword = useCallback(() => {
    setPasswordRequest(null);
  }, []);

  const startSession = useCallback(
    async (
      session: SavedSession & {
        password?: string;
      },
      sourceSessionId: string,
      /** false 时不把新会话设为激活（拆分场景） */
      activate = true
    ) => {
      // 先把跳板链与私钥解析好，再建终端：SFTP / AI 命令通道要用的
      // 连接目标必须与终端会话同时就绪，不能等第一次 AI 调用再补。
      // 密码解密是异步 IPC，放在挂载前只多几毫秒。
      const execTarget = await buildSshTarget(
        session,
        sessions,
        {
          keyPath: sshKeyPath,
          // 这里的密码已经是明文（由 open() 解密或用户在弹窗里输入）
          password: session.password ?? null
        }
      );
      // 远端 shell 集成（OSC 133）的钩子：**尽早发起、绝不等待**。
      //
      // 钩子只有在本条连接握手之前装好才生效，而部署要额外走一次 ssh2
      // 连接。抢在 createTerminal / 等尺寸（几百毫秒）前面发起，网络快时
      // 能赶上；赶不上就下次连接生效 —— 所有消费方都有启发式兜底。
      //
      // ⚠️ 绝不能 await：终端能用是第一位的，部署路径（认证、hostkey、
      // 超时）任何一处出问题都不该让用户对着空白终端干等。
      const shellIntegration =
        session.kind === "ssh"
          ? ensureShellIntegration(execTarget)
          : Promise.resolve(false);
      const current = createTerminal(
        session,
        sourceSessionId,
        execTarget
      );
      setOpened(prev => {
        const next = [...prev, current];
        openedRef.current = next;
        return next;
      });
      setDisconnected(prev => {
        const next = { ...prev };
        delete next[session.id];
        disconnectedRef.current = next;
        return next;
      });
      if (activate) {
        // 新会话进活动窗格并立刻显示（activate=false 的拆分场景由
        // splitPaneBy 自己往新窗格写，两边不能都写）
        const paneId =
          activePaneRef.current?.id ??
          panesRef.current[0]?.id;
        if (paneId) {
          setPanes(prev =>
            prev.map(p =>
              p.id === paneId
                ? {
                    ...p,
                    tabIds: p.tabIds.includes(
                      session.id
                    )
                      ? p.tabIds
                      : [...p.tabIds, session.id],
                    visibleId: session.id
                  }
                : p
            )
          );
        }
      }
      // 先挂载、等尺寸稳定，再启动 PTY：PTY 直接按最终尺寸出生，首帧不再有
      // resize。ConPTY 的整屏重绘（会抹掉欢迎横幅、堆出重复提示符）因此
      // 根本不会发生
      await waitForStableSize(current.element);
      // 稳定后再 fit 一次：下面交给后端的行列数必须是最终值，
      // 否则 PTY 一生下来就与实际不符，紧接着的 resize 又要重绘
      current.fit.fit();
      // 部署**完全不参与建连时序**：只发起，不等待。
      //
      // 理由：终端能用是第一位的。远端钩子只有在本条连接握手之前装好才
      // 生效，而部署要额外走一次 ssh2 连接 —— 等它就意味着用户对着空白
      // 终端干等，一旦部署路径（认证、hostkey、超时）有任何问题，终端就
      // 起不来。抢在 terminal_start 前面发起，网络快时能赶上；赶不上就
      // 下次连接生效，这中间所有消费方都有启发式兜底。
      void shellIntegration
        .then(installed => {
          console.info(
            `[shell-integration] 会话 ${session.id} 部署${
              installed ? "完成" : "跳过/失败"
            }（若晚于 shell 启动，下次连接生效）`
          );
        })
        .catch(reason => {
          console.warn(
            "[shell-integration] 部署流程异常，已忽略",
            reason
          );
        });
      try {
        await invoke("terminal_start", {
          config: {
            ...session,
            // 连接层全局设置：私钥、config 开关与密钥策略（见 settings.ts）
            sshKeyPath,
            useSshConfig,
            hostKeyPolicy,
            // 跳板链现场解析：规格跟着跳板会话的最新地址走
            jump: resolveJumpChain(
              session,
              sessions
            ),
            rows: current.terminal.rows,
            cols: current.terminal.cols
          }
        });
        // PTY 就是按这个尺寸出生的，先记上：随后若布局没变就不必再同步
        syncedSizes.current.set(
          current.id,
          `${current.terminal.rows}x${current.terminal.cols}`
        );
        // PTY 建好后按当前尺寸再校一次：从挂载到这一刻之间布局可能已经变了
        // （AI 面板、侧栏、字体度量），而挂载时那次 resize 会因为「会话还没
        // 建立」被后端拒掉 —— 不补这一下，PTY 就一直停在旧宽度上
        schedulePtyResize(current);
      } catch (reason) {
        setOpened(prev => {
          const next = prev.filter(
            s => s !== current
          );
          openedRef.current = next;
          return next;
        });
        onError(reason);
        return false;
      }
      return true;
    },
    [
      createTerminal,
      onError,
      schedulePtyResize,
      setPanes,
      activePaneRef,
      panesRef,
      syncedSizes,
      setOpened,
      openedRef,
      setDisconnected,
      disconnectedRef,
      sshKeyPath,
      useSshConfig,
      hostKeyPolicy,
      sessions
    ]
  );

  const open = useCallback(
    async (
      session: SavedSession,
      sourceSessionId = session.id,
      /** false 时不把新会话设为激活（拆分场景：新会话由调用方放进新窗格） */
      activate = true
    ) => {
      const current = openedRef.current.find(
        item => item.id === session.id
      );
      if (current) {
        // 已打开：切到它所在的窗格并显示（activateTab 内部会找归属）
        activateTab(session.id);
        return;
      }
      if (session.kind === "ssh") {
        if (session.password) {
          try {
            const plain = await invoke<string>(
              "decrypt",
              { encoded: session.password }
            );
            await startSession(
              { ...session, password: plain },
              sourceSessionId,
              activate
            );
            return;
          } catch {
            /* fall through */
          }
        }
        setPasswordRequest({
          session,
          sourceSessionId
        });
        return;
      }
      await startSession(
        session,
        sourceSessionId,
        activate
      );
    },
    [startSession, activateTab, openedRef]
  );

  /**
   * 不走密码、直接用私钥 / ssh-agent 连接。
   *
   * 纯密钥登录的会话不该被密码框卡住：用户在设置里配了默认私钥，或
   * 本机 ssh-agent 里已有可用身份时，从这里直接启动。不保存任何密码，
   * 终端里的 ssh 会按自己的规则完成认证。
   */
  const useKeyAuth = useCallback(async () => {
    const request = passwordRequest;
    if (!request) return;
    setPasswordRequest(null);
    await startSession(
      { ...request.session, password: undefined },
      request.sourceSessionId
    );
  }, [passwordRequest, startSession]);

  const submitPassword = useCallback(
    async (password: string) => {
      const request = passwordRequest;
      if (!request) return;
      setPasswordRequest(null);
      try {
        const encrypted = await invoke<string>(
          "encrypt",
          { plain: password }
        );
        onSavePassword?.(
          request.sourceSessionId,
          encrypted
        );
      } catch (reason) {
        onError(reason);
      }
      await startSession(
        { ...request.session, password },
        request.sourceSessionId
      );
    },
    [
      passwordRequest,
      onError,
      onSavePassword,
      startSession
    ]
  );

  /** 复制/拆分共用的命名：首个实例用原名，之后 (2)(3)…，避开已打开标签。 */
  const nextDupName = useCallback(
    (base: string) => {
      let n = 1;
      const nameAt = (i: number) =>
        i === 1 ? base : `${base} (${i})`;
      while (
        openedRef.current.some(
          item => item.name === nameAt(n)
        )
      )
        n++;
      return nameAt(n);
    },
    [openedRef]
  );

  const duplicate = useCallback(
    async (
      session: SavedSession,
      activate = true
    ) => {
      const newId = `dup-${session.id}-${Date.now()}`;
      await open(
        {
          ...session,
          id: newId,
          name: nextDupName(session.name)
        },
        session.id,
        activate
      );
      return newId;
    },
    [open, nextDupName]
  );

  return {
    passwordRequest,
    submitPassword,
    useKeyAuth,
    cancelPassword,
    startSession,
    open,
    duplicate,
    nextDupName
  };
}
