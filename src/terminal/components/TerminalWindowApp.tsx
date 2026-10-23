/**
 * 独立终端窗口的内容（`?terminal=<id>`）。
 *
 * 这个窗口**不启动 PTY**：会话在主窗口里跑着，这里只做「接管」——
 * 改输出归属 + 回放最近画面。所以实现比主窗口那套轻得多：一只 xterm、
 * 一个输出监听、一个 resize 同步、一个输入管道。
 *
 * 关窗 = 会话结束（产品决定），交由后端在窗口销毁时处理（见
 * `open_terminal_window` 的 on_window_event），这里不做收尾。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { loadSession } from "@/sessions/lib/useSessions";
import { loadSettings } from "@/settings/lib/settings";
import { useT } from "@/settings/lib/i18n";
import {
  logError,
  logInfo
} from "@/shared/lib/log";
import "@xterm/xterm/css/xterm.css";
import "@/styles/app.scss";

/** 回填给 PTY 的尺寸变化要节流，避免拖动窗口时把 resize 刷爆。 */
const RESIZE_DEBOUNCE_MS = 120;

export default function TerminalWindowApp({
  sessionId,
  sourceId
}: {
  sessionId: string;
  /** 保存会话 id：dup- 临时会话查不到自己时按它兜底取名字 */
  sourceId?: string | null;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  // 会话可能已被主窗口删掉：在渲染层判断，别在 effect 里 setState
  // （react-hooks/set-state-in-effect 会拦，也确实容易引起级联渲染）
  // dup- 临时会话不在 localStorage 里，按 source 兜底——找不到时才显示错误
  const session = useMemo(
    () =>
      loadSession(sessionId) ??
      (sourceId ? loadSession(sourceId) : null),
    [sessionId, sourceId]
  );

  useEffect(() => {
    if (!session) return;
    const host = hostRef.current;
    if (!host) return;
    const settings = loadSettings();

    const terminal = new Terminal({
      fontFamily:
        settings.fontFamily || undefined,
      fontSize: settings.fontSize,
      cursorBlink: true,
      theme: {
        background:
          getComputedStyle(document.body)
            .getPropertyValue("--background")
            .trim() || "#0b0b0c"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    let disposed = false;
    let resizeTimer: ReturnType<
      typeof setTimeout
    > | null = null;
    const unlisteners: Array<() => void> = [];

    /** 把当前尺寸同步给 PTY（同尺寸由后端跳过）。 */
    const syncSize = () => {
      if (disposed) return;
      fit.fit();
      void invoke("terminal_resize", {
        id: sessionId,
        rows: terminal.rows,
        cols: terminal.cols
      }).catch(reason => {
        logError(
          "[term-window] resize 失败",
          reason
        );
      });
    };

    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null)
        clearTimeout(resizeTimer);
      resizeTimer = setTimeout(
        syncSize,
        RESIZE_DEBOUNCE_MS
      );
    });
    observer.observe(host);

    void (async () => {
      // 先接管再挂监听：attach 返回的是接管前的回放内容，
      // 之后到达的输出走事件，两段不会重叠也不会漏
      try {
        const replay = await invoke<string>(
          "terminal_attach",
          { id: sessionId }
        );
        if (disposed) return;
        if (replay) terminal.write(replay);
        logInfo(
          "[term-window] 已接管会话",
          sessionId,
          `${replay.length} 字节回放`
        );
      } catch (reason) {
        logError(
          "[term-window] 接管失败",
          reason
        );
        setError(String(reason));
      }
      syncSize();

      unlisteners.push(
        await listen<{
          id: string;
          data: string;
        }>("terminal-output", ({ payload }) => {
          if (payload.id !== sessionId) return;
          terminal.write(payload.data);
        })
      );
      unlisteners.push(
        await listen<{
          id: string;
          code: number | null;
        }>("terminal-exit", ({ payload }) => {
          if (payload.id !== sessionId) return;
          terminal.write(
            "\r\n[会话已结束，可以关闭此窗口]\r\n"
          );
        })
      );

      terminal.onData(data => {
        void invoke("terminal_write", {
          id: sessionId,
          data
        }).catch(reason => {
          logError(
            "[term-window] 写入失败",
            reason
          );
        });
      });
      terminal.focus();
    })();

    return () => {
      disposed = true;
      if (resizeTimer !== null)
        clearTimeout(resizeTimer);
      observer.disconnect();
      for (const off of unlisteners) off();
      terminal.dispose();
    };
  }, [session, sessionId]);

  return (
    <div className="terminal-window-root">
      {/* 自绘标题栏：窗口是 decorations(false)（与主窗口一致），
          没有它这个窗口既拖不动也关不掉 —— 实测用户只能强杀进程 */}
      <div
        className="terminal-window-bar"
        data-tauri-drag-region
      >
        <span className="terminal-window-title">
          {session?.name ?? "终端"}
        </span>
        <button
          type="button"
          className="terminal-window-close"
          aria-label={t("app.action.close")}
          onClick={() => {
            void getCurrentWindow().close();
          }}
        >
          ×
        </button>
      </div>
      <div
        className="terminal-window-host"
        ref={hostRef}
      />
      {!session && (
        <div className="terminal-window-error">
          找不到这个会话（可能已被删除）
        </div>
      )}
      {error && (
        <div className="terminal-window-error">
          {error}
        </div>
      )}
    </div>
  );
}
