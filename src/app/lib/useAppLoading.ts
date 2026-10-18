import {
  useEffect,
  useRef,
  useState
} from "react";
import type { AppLoadingHandle } from "@/app/components/AppLoading";

/**
 * 开场加载层与「应用就绪」状态。
 *
 * 只负责两件事：启动时把第一个会话塞进终端、维持 5 秒下限的动效计时。
 * 开哪个会话由门面决定（`openFirstSession`），本 hook 不认识会话列表。
 */
export function useAppLoading(
  openFirstSession: () => void
) {
  const [appReady, setAppReady] = useState(false);
  const appLoadingRef =
    useRef<AppLoadingHandle>(null);
  const loadingTimerRef =
    useRef<ReturnType<typeof setTimeout>>(
      undefined
    );

  useEffect(() => {
    openFirstSession();
    // 动效至少播放 5 秒：主界面渲染就绪后等待剩余时间，再淡出进入应用。
    loadingTimerRef.current = setTimeout(() => {
      appLoadingRef.current?.finish();
    }, 5000);
    return () =>
      clearTimeout(loadingTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 动效淡出完毕：摘掉遮罩，正式进入应用。 */
  function handleLoadingFinished() {
    clearTimeout(loadingTimerRef.current);
    setAppReady(true);
  }

  return {
    appReady,
    appLoadingRef,
    handleLoadingFinished
  };
}
