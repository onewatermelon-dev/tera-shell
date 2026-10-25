/**
 * 记住窗口在桌面的位置与大小。
 *
 * ## 为什么存逻辑像素
 *
 * Tauri 的 `outerPosition/outerSize` 返回的是**物理**像素。直接存物理值
 * 有个坑：换一台 DPI 不同的显示器（或把窗口拖到缩放比不同的屏幕），
 * 同样的物理像素会变成不一样的实际大小。这里统一除以当前缩放比存
 * **逻辑**像素，恢复时也用逻辑值 —— 跨屏拖动时大小才稳定。
 *
 * ## 最大化时怎么办
 *
 * 最大化时 `outerSize` 是**屏幕**大小，把它存下来就等于下次启动直接
 * 开一个全屏窗口。所以最大化状态下只记「最大化」这个标志，尺寸沿用
 * 上一次记录的常规尺寸（还原后的大小）。
 *
 * ## 位置没了怎么办
 *
 * 拔掉外接显示器后，存档里的坐标可能落在不存在的屏幕上 —— 窗口会
 * 开到屏幕外，用户以为应用没启动。恢复前先检查存档矩形与某块显示器的
 * 工作区是否相交，不相交就只恢复大小、位置交给系统居中。
 */

import { useEffect } from "react";
import {
  availableMonitors,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize
} from "@tauri-apps/api/window";
import { logWarn } from "@/shared/lib/log";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/** 一份窗口状态（逻辑像素）。 */
export type WindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 关闭时是否最大化（尺寸记的是「还原后」的大小） */
  maximized: boolean;
};

/** 尺寸下限：比这更小基本没法用。 */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
/** 尺寸上限：脏数据别把窗口撑到离谱。 */
const MAX_WIDTH = 7680;
const MAX_HEIGHT = 4320;

/** 读存档；没有或坏了都返回 null（调用方保留系统默认）。 */
export function loadWindowState(): WindowState | null {
  const raw = readData(DataName.windowState);
  if (!raw) return null;
  try {
    return sanitizeWindowState(JSON.parse(raw));
  } catch (reason) {
    logWarn(
      "[window-state] 存档解析失败，按「没有存档」处理",
      reason
    );
    return null;
  }
}

/** 写存档。 */
export function saveWindowState(
  state: WindowState
): void {
  writeData(
    DataName.windowState,
    JSON.stringify(state)
  );
}

/**
 * 清洗存档（纯函数，可单测）。
 *
 * 尺寸越界时**钳回**合法区间而不是整条作废：位置还有参考价值，
 * 为此把整份存档丢掉不划算。
 */
export function sanitizeWindowState(
  raw: unknown
): WindowState | null {
  const data = raw as Partial<WindowState> | null;
  if (!data || typeof data !== "object")
    return null;
  const numbers = [
    data.x,
    data.y,
    data.width,
    data.height
  ];
  if (
    !numbers.every(
      value =>
        typeof value === "number" &&
        Number.isFinite(value)
    )
  )
    return null;
  const width = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, Math.round(data.width!))
  );
  const height = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Math.round(data.height!))
  );
  return {
    x: Math.round(data.x!),
    y: Math.round(data.y!),
    width,
    height,
    maximized: data.maximized === true
  };
}

/**
 * 启动时恢复窗口位置与大小（窗口已创建后调用）。
 *
 * 位置不在任何显示器上时只恢复大小 —— 位置交给系统居中，
 * 免得窗口开到屏幕外、用户以为应用没起来。
 */
export async function restoreWindowState(): Promise<void> {
  const saved = loadWindowState();
  if (!saved) return;
  const app = getCurrentWindow();
  try {
    await app.setSize(
      new LogicalSize(saved.width, saved.height)
    );
    if (saved.maximized) {
      await app.maximize();
      return;
    }
    if (await positionVisible(saved))
      await app.setPosition(
        new LogicalPosition(saved.x, saved.y)
      );
  } catch (reason) {
    logWarn(
      "[window-state] 恢复窗口位置/大小失败，保留系统默认",
      reason
    );
  }
}

/**
 * 存档矩形是否还落在某块显示器上。
 *
 * 显示器坐标是物理像素、存档是逻辑像素，这里用当前缩放比粗略换算 ——
 * 目的只是判断「那块屏还在不在」，精度不需要太高。
 */
async function positionVisible(
  state: WindowState
): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    if (!monitors.length) return true;
    const scale =
      await getCurrentWindow().scaleFactor();
    return monitors.some(monitor => {
      const area = monitor.workArea;
      const left = area.position.x / scale;
      const top = area.position.y / scale;
      const right =
        left + area.size.width / scale;
      const bottom =
        top + area.size.height / scale;
      // 有一角落在工作区里就算「还在屏幕上」
      return (
        state.x < right &&
        state.x + state.width > left &&
        state.y < bottom &&
        state.y + state.height > top
      );
    });
  } catch {
    // 读不到显示器信息就别拦着用户 —— 位置照旧恢复
    return true;
  }
}

/**
 * 监听窗口移动/缩放并落盘（主窗口挂一次）。
 *
 * 去抖 300ms：拖动窗口是连续事件，每帧写一次磁盘没道理。
 * 另外在页面隐藏/卸载时再存一次 —— 去抖窗口里最后那一下有可能被吃掉。
 */
export function useWindowStatePersistence(): void {
  useEffect(() => {
    const app = getCurrentWindow();
    let timer: number | null = null;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    /** 最近一次「非最大化」时的几何：最大化时尺寸是屏幕尺寸，不能存 */
    let normal: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;

    const capture =
      async (): Promise<WindowState | null> => {
        const maximized = await app.isMaximized();
        const position =
          await app.outerPosition();
        const size = await app.outerSize();
        const scale = await app.scaleFactor();
        const x = Math.round(position.x / scale);
        const y = Math.round(position.y / scale);
        const width = Math.round(
          size.width / scale
        );
        const height = Math.round(
          size.height / scale
        );
        if (maximized) {
          // 沿用上一次的常规尺寸，别把屏幕大小存进去
          return normal
            ? { ...normal, maximized: true }
            : null;
        }
        normal = { x, y, width, height };
        return {
          x,
          y,
          width,
          height,
          maximized: false
        };
      };

    const save = async () => {
      try {
        const state = await capture();
        if (state) saveWindowState(state);
      } catch (reason) {
        logWarn(
          "[window-state] 记录窗口状态失败",
          reason
        );
      }
    };

    const schedule = () => {
      if (timer !== null)
        window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void save();
      }, 300);
    };

    const listen = (
      register: () => Promise<() => void>
    ) => {
      void register()
        .then(unlisten => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(reason => {
          logWarn(
            "[window-state] 监听窗口事件失败",
            reason
          );
        });
    };
    listen(() => app.onMoved(schedule));
    listen(() => app.onResized(schedule));

    // 关闭前再存一次：去抖窗口里最后一下可能被吃掉
    const flush = () => {
      void save();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener(
      "beforeunload",
      flush
    );

    return () => {
      disposed = true;
      if (timer !== null)
        window.clearTimeout(timer);
      window.removeEventListener(
        "pagehide",
        flush
      );
      window.removeEventListener(
        "beforeunload",
        flush
      );
      unlisteners.forEach(unlisten => unlisten());
    };
  }, []);
}
