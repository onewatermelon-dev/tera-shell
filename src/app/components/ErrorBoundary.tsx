/**
 * 渲染崩溃的兜底。
 *
 * React 的渲染异常会**卸载整棵树**，页面变成白屏 —— 以前这种白屏既没有
 * 日志（异常只出现在 DevTools 控制台），也没有出口，用户只能截图说
 * 「打不开了」。这里做三件事：写日志、显示原因、给「导出诊断包」的按钮。
 *
 * 文案用中英并排：类组件拿不到 `useT`，而崩溃页是低频页面，不值得为了
 * 它把 i18n 做成全局函数。
 */
import {
  Component,
  type ErrorInfo,
  type ReactNode
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "@/shared/lib/log";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<
  Props,
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(
    error: Error
  ): State {
    return { error };
  }

  componentDidCatch(
    error: Error,
    info: ErrorInfo
  ): void {
    // 组件栈是排查渲染崩溃最有用的线索
    logError(
      "[react] 渲染崩溃",
      error,
      info.componentStack ?? ""
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <h1 className="crash-title">
          界面出错了 · Something went wrong
        </h1>
        <p className="crash-reason">
          {error.message}
        </p>
        <p className="crash-hint">
          可以重新加载，或导出诊断包（含近 3
          天日志）反馈给我们。
          <br />
          Reload, or export a diagnostics bundle
          to report this.
        </p>
        <div className="crash-actions">
          <button
            type="button"
            className="crash-btn"
            onClick={() =>
              window.location.reload()
            }
          >
            重新加载 · Reload
          </button>
          <button
            type="button"
            className="crash-btn"
            onClick={() => void exportBundle()}
          >
            导出诊断包 · Export diagnostics
          </button>
        </div>
      </div>
    );
  }
}

/** 崩到这一步时只能用 alert 反馈（toast 挂在被卸载的树里）。 */
async function exportBundle(): Promise<void> {
  try {
    const info = await invoke<{ path: string }>(
      "diagnostics_export",
      { days: 3 }
    );
    window.alert(`诊断包已保存：${info.path}`);
  } catch (reason) {
    logError(
      "[react] 崩溃页导出诊断失败",
      reason
    );
    window.alert(`导出失败：${String(reason)}`);
  }
}
