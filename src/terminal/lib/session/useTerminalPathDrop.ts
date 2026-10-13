import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn
} from "@tauri-apps/api/event";
import type { OpenSession } from "./terminalTypes";
import type { PaneState } from "./paneGrid";

/**
 * 接收 SFTP 窗口拖出来的路径（拖路径进终端）。
 *
 * 从 useTerminals 搬出：整段是一个自包含的挂载期 effect，只读
 * openedRef / panesRef 两份镜像，不碰任何 state。
 *
 * 跨窗口握手：SFTP 拖拽窗口持有 OS 鼠标捕获，光标拖到主窗口上
 * 松手时 pointerup 仍送达 SFTP 窗口（诊断日志实锤），由它广播
 * `sftp-paths-to-terminal`（文本 + 会话 id + 光标屏幕坐标）。
 * 主窗口这里：坐标落在自己范围内才接；目标按 id /
 * sourceSessionId 双向解析（复制会话的终端 id 是
 * `dup-<原 id>-<时间戳>`，SFTP 绑定的是保存会话的 id）；
 * 写入 PTY 的是不带换行的文本，落在 shell 输入行里。
 * 挂载期注册一次（状态走 openedRef / panesRef 镜像）。
 */
export function useTerminalPathDrop(options: {
  openedRef: RefObject<OpenSession[]>;
  panesRef: RefObject<PaneState[]>;
}) {
  const { openedRef, panesRef } = options;
  useEffect(() => {
    /** 链路诊断：console + 后端日志文件（排查跨窗口丢事件用）。 */
    const trace = (message: string) => {
      console.info(`[path-drop] ${message}`);
      void invoke("debug_log", {
        message: `[path-drop] ${message}`
      }).catch(() => {});
    };

    let dispose: UnlistenFn | undefined;
    void listen<{
      sessionId: string;
      text: string;
      screenX: number;
      screenY: number;
    }>("sftp-paths-to-terminal", event => {
      const {
        sessionId,
        text,
        screenX,
        screenY
      } = event.payload;
      // 光标不在主窗口内不接（广播是全窗口的，各窗口自行判断）
      const inside =
        screenX >= window.screenX &&
        screenX <=
          window.screenX + window.outerWidth &&
        screenY >= window.screenY &&
        screenY <=
          window.screenY + window.outerHeight;
      trace(
        `drop received session=${sessionId} inside=${inside} text=${text}`
      );
      if (!inside) return;
      const target = openedRef.current.find(
        item =>
          item.id === sessionId ||
          item.sourceSessionId === sessionId
      );
      const targetPane = target
        ? panesRef.current.find(
            item =>
              item.visibleId === target.id ||
              item.tabIds.includes(target.id)
          )
        : undefined;
      trace(
        `target=${target ? target.id : "miss"} pane=${targetPane ? "hit" : "miss"}`
      );
      if (!target || !targetPane) return;
      invoke("terminal_write", {
        id: target.id,
        data: text,
        command: null
      })
        .then(() => {
          trace(`write ok: ${text}`);
        })
        .catch(reason => {
          trace(`write fail: ${String(reason)}`);
        });
    }).then(unlisten => {
      dispose = unlisten;
    });
    return () => dispose?.();
    // refs 身份稳定，列出来只为满足 exhaustive-deps；
    // effect 本身仍只随挂载注册一次
  }, [openedRef, panesRef]);
}
