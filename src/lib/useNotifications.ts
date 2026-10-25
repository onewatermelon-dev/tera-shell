/**
 * 通知的接线层：把「谁触发了事件」翻译成一条系统通知。
 *
 * ## 为什么用 hook 包一层而不是各调用点自己 import notify
 *
 * `notifySend.notify` 需要**当下最新的设置**（用户随时可能改开关），
 * 而触发点（终端计时结束、AI 流结束、传输完成）都是长期持有的回调 ——
 * 直接在组件里写闭包会读到创建那一刻的旧设置，表现为「改了开关不生效」。
 * 这里用 ref 兜住最新值，对外只暴露身份稳定的回调。
 */
import {
  useCallback,
  useEffect,
  useRef
} from "react";
import type { AppSettings } from "@/settings/lib/settings";
import {
  aiNotification,
  commandNotification,
  notify as sendNotify,
  transferNotification,
  watchNotification
} from "@/lib/notifySend";
import { registerAiDoneHandler } from "@/lib/notifyBridge";

export function useNotifications(
  settings: AppSettings
) {
  // 用 ref 而不是闭包：回调身份要稳定（要进别的 hook 的依赖数组），
  // 但读到的必须是最新设置。
  // ⚠️ 赋值放在 effect 里而不是渲染期：渲染期改 ref 会让这次渲染
  // 「看起来用了旧值」，并发渲染下还可能出现撕裂
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /** 长命令跑完。 */
  const notifyCommand = useCallback(
    (command: string, elapsedMs: number) =>
      sendNotify(
        settingsRef.current,
        commandNotification(command, elapsedMs),
        { elapsedMs }
      ),
    []
  );

  /**
   * AI 回答完成通知。
   *
   * `preview` 是回答开头的一小段，让用户在通知里能认出问的是什么 ——
   * 同时跑多个会话时，只给「AI 回答完成」等于什么都没说。
   */
  const notifyAiDone = useCallback(
    (
      modelName: string,
      elapsedMs: number,
      preview: string
    ) =>
      sendNotify(
        settingsRef.current,
        aiNotification(
          modelName,
          elapsedMs,
          preview
        )
      ),
    []
  );

  // AI 完成事件走桥接注册（见 lib/notifyBridge）：触发点在数据层
  // aiChat.ts，中间隔着两层 UI 组件，透传 props 得不偿失
  useEffect(
    () => registerAiDoneHandler(notifyAiDone),
    [notifyAiDone]
  );

  /** 传输结束；`summary` 形如「3 个文件」。 */
  const notifyTransferDone = useCallback(
    (summary: string, succeeded: boolean) =>
      sendNotify(
        settingsRef.current,
        transferNotification(summary, succeeded)
      ),
    []
  );

  /**
   * 值守巡检告警 / 恢复。
   *
   * 这一类同样受「仅窗口未聚焦时通知」约束 —— 用户正看着某个终端时，
   * 突然弹一条系统通知会打断他手里的事；此时告警仍然记进面板与历史，
   * 只是换个安静的方式呈现（这条纪律与长命令通知一致）。
   */
  const notifyWatch = useCallback(
    (
      summary: string,
      level: "alert" | "recover",
      repeat = false
    ) =>
      sendNotify(
        settingsRef.current,
        watchNotification(summary, level, repeat)
      ),
    []
  );

  return {
    notifyCommand,
    notifyAiDone,
    notifyTransferDone,
    notifyWatch
  };
}
