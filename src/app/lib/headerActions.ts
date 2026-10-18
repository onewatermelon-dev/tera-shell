import { invoke } from "@tauri-apps/api/core";
import type { HeaderActions } from "@/app/components/AppHeader";
// 只取类型：终端状态仍由门面创建，这里按 ReturnType 拿返回面
import type { useTerminals } from "@/terminal/lib/session/useTerminals";

/** useTerminals 的返回面。 */
type TerminalsApi = ReturnType<
  typeof useTerminals
>;

/**
 * 组装标题栏菜单动作表。
 *
 * 纯函数而非 hook：里面没有任何 React 状态，动作的每次渲染重建与
 * 原实现一致（AppHeader 只在这几个回调被点的时候读它们）。
 *
 * 依赖显式列全：终端 store、错误提示、以及各动作的来源回调
 * （会话弹窗、导入导出、焦点回还、设置页各自住在别的模块）。
 */
export function buildHeaderActions(options: {
  terminals: TerminalsApi;
  fail: (reason: unknown) => void;
  openCreate: () => void;
  openLocal: () => void;
  exportSessions: () => void;
  importSessions: () => void;
  refocusActive: () => void;
  openSettings: () => void;
}): HeaderActions {
  const {
    terminals,
    fail,
    openCreate,
    openLocal,
    exportSessions,
    importSessions,
    refocusActive,
    openSettings
  } = options;
  return {
    newSession: openCreate,
    openLocal,
    closeActive: () => {
      if (terminals.active)
        terminals.close(terminals.active.id);
    },
    find: terminals.openSearch,
    copy: () => {
      const terminal = terminals.active?.terminal;
      if (!terminal?.hasSelection()) return;
      navigator.clipboard
        .writeText(terminal.getSelection())
        .catch(fail);
    },
    paste: () => {
      const terminal = terminals.active?.terminal;
      if (!terminal) return;
      navigator.clipboard
        .readText()
        .then(text => {
          if (text) terminal.paste(text);
        })
        .catch(fail);
    },
    selectAll: () =>
      terminals.active?.terminal.selectAll(),
    clear: () =>
      terminals.active?.terminal.clear(),
    devtools: () => {
      invoke("open_devtools").catch(fail);
    },
    // 右键菜单里点「重新连接」传的是会话自己的 id；全局键位只能作用于
    // 活动会话（快捷键没有「鼠标指哪儿」的上下文）
    reconnect: () => {
      const active = terminals.active;
      if (!active) {
        fail("请先打开一个会话");
        return;
      }
      terminals.reconnect(active.id);
    },
    toggleFocusMode: () => {
      // 专注模式切的是 body 上的类，样式与 CSS 钩子共用；
      // 切完要重新 fit —— 见 useTerminals 的 resize 里对
      // terminal-focus 的特判（专注模式只扩高，不动列数）
      document.body.classList.toggle(
        "terminal-focus"
      );
      terminals.resize();
    },
    openSftp: () => {
      const active = terminals.active;
      if (!active) {
        fail("请先打开一个会话");
        return;
      }
      // 传 sourceSessionId 而不是 id：复制出来的会话 id 是临时的
      // `dup-<原 id>-<时间戳>`，不落库，独立窗口按它取不到会话。
      // sourceSessionId 始终指向真正保存过的那个会话。
      // 每个 SFTP 会话开一个真正的系统窗口：会出现在任务栏里，
      // 可以并排摆放，也不会挡住主窗口里的终端
      invoke("open_sftp_window", {
        sessionId: active.sourceSessionId,
        title: active.name
      }).catch(fail);
    },
    openSettings,
    exportSessions,
    importSessions,
    refocusTerminal: refocusActive
  };
}
