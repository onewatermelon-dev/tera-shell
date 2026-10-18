import {
  useCallback,
  useEffect,
  useState
} from "react";

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
  /** 读写剪贴板 / 调后端失败等统一走右下角错误提示。 */
  const fail = useCallback(
    (reason: unknown) => setError(String(reason)),
    []
  );
  return { error, setError, fail };
}
