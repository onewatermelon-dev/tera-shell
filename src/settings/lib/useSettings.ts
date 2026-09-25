import {
  useCallback,
  useEffect,
  useState
} from "react";
import { emit } from "@tauri-apps/api/event";
import {
  applyLocale,
  applyTheme,
  loadSettings,
  saveSettings,
  type AppSettings
} from "@/settings/lib/settings";
import { setLocale } from "@/settings/lib/i18n";

/**
 * 设置的状态管理。
 *
 * 主题是唯一一个需要「立即生效」的副作用 —— 它改的是文档根元素上的属性，
 * 所以在这里直接同步，组件不用关心什么时候应用。
 * 字体与字号则要等终端实例去读取，由 useTerminals 负责。
 */
export function useSettings() {
  const [settings, setSettings] =
    useState<AppSettings>(loadSettings);

  // 启动与变更时都同步一次：刷新页面后属性不会残留旧值
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // 语言：落到 <html lang>（断词、字体回退、读屏发音），
  // 并同步给 i18n store —— 订阅它的组件会自动重渲染
  useEffect(() => {
    applyLocale(settings.locale);
    setLocale(settings.locale);
  }, [settings.locale]);

  // 外观广播：SFTP 独立窗口不挂 useSettings，靠这个事件跟随主题与语言
  // （监听端在 main.tsx 的 bootstrap；只挂在主窗口的 App 上，SFTP 窗口不会回播）
  useEffect(() => {
    emit("app://appearance-changed", {
      theme: settings.theme,
      locale: settings.locale
    }).catch(() => {});
  }, [settings.theme, settings.locale]);

  /** 局部更新某一项，写回存储并刷新状态。 */
  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings(prev => {
        const next = {
          ...prev,
          ...patch
        };
        saveSettings(next);
        return next;
      });
    },
    []
  );

  return {
    settings,
    update
  };
}
