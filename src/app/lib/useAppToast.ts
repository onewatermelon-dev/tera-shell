import {
  useCallback,
  useEffect,
  useState
} from "react";
import { logError } from "@/shared/lib/log";

/**
 * 右下角错误气泡。
 *
 * 数秒后自动消失：原本只有"点击消失"这一种隐晦交互，用户不知道能点，
 * 错误会一直挂在角落（如关闭会话后残留的写失败提示）。
 *
 * 提成独立 hook 是因为 setError 的消费者遍布全应用（终端写失败、
 * 剪贴板、导入导出、后端调用），放在门面里再逐层往下传参数太吵。
 */
export function useAppToast() {
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(
      () => setError(""),
      5000
    );
    return () => clearTimeout(timer);
  }, [error]);
  /**
   * 失败出口：**任何显示给用户的错误都会写进日志**。
   *
   * 这是全应用的错误汇聚点 —— 业务代码到处 `setError(...)`，以前这些
   * 文本只闪 5 秒就消失，诊断包里一个字都看不到。
   */
  const reportError = useCallback(
    (message: string) => {
      // 关闭提示（setError("")）不该记一条错误
      if (message) logError("[toast]", message);
      setError(message);
    },
    []
  );

  /** 只显示、不记日志：用于成功提示（如「诊断包已保存到 …」）。 */
  const notify = useCallback(
    (message: string) => setError(message),
    []
  );

  /** 读写剪贴板 / 调后端失败等统一走右下角错误提示（并落盘）。 */
  const fail = useCallback((reason: unknown) => {
    const text = String(reason);
    logError("[fail]", text);
    setError(text);
  }, []);

  return {
    error,
    setError: reportError,
    fail,
    notify
  };
}
