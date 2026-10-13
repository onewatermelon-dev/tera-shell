import { useEffect, type RefObject } from "react";
import { resolveFontFamily } from "@/settings/lib/settings";
import {
  resolveColorScheme,
  toXtermTheme
} from "@/terminal/lib/pane/colorSchemes";
import type { OpenSession } from "./terminalTypes";
import {
  applyWebglPreference,
  type TerminalAppearance
} from "./terminalCreate";

/**
 * 终端外观（字体/字号/配色/补全开关/硬件加速）与回滚行数的下发。
 *
 * 从 useTerminals 搬出：两个 effect 都只读 openedRef 镜像、写终端实例
 * 自己的可变 options，与编排状态无关。字号变化走 `pausePtySync` 挂起
 * PTY 同步并补一次（flush=true）—— 机制见 ptyResize 与 useTerminals
 * 里的注释，这里原样保留。
 */
export function useTerminalAppearance(options: {
  appearance: TerminalAppearance;
  openedRef: RefObject<OpenSession[]>;
  pausePtySync: (
    settleMs?: number,
    flush?: boolean
  ) => void;
  resize: (current?: OpenSession) => void;
}) {
  const {
    appearance,
    openedRef,
    pausePtySync,
    resize
  } = options;

  /**
   * 设置里的字体/字号变化后，同步到所有已打开的终端。
   *
   * 字体或字号一变，字符的宽高就跟着变，行列数必须重算 —— 否则内容会
   * 与容器错位、右侧留出一条空白。`resize` 负责 fit 并把新尺寸告知后端 PTY。
   */
  useEffect(() => {
    const family = resolveFontFamily(
      appearance.fontFamily
    );
    // 硬件加速开关：关掉时释放已启用终端上的 addon，xterm 自动落回
    // DOM 渲染器（已有终端无需重建，屏幕内容立刻重新绘制）。
    applyWebglPreference(
      appearance.webglRender,
      openedRef.current.map(s => s.terminal)
    );
    const theme = toXtermTheme(
      resolveColorScheme(appearance.colorScheme)
    );
    for (const session of openedRef.current) {
      // xterm 只暴露 options 这个可变对象，没有 setter —— 想改字体就只能
      // 就地赋值。react-hooks/immutability 约束的是 React 自身的数据，
      // 对第三方实例的可变配置不适用，故此处显式放行。
      /* eslint-disable react-hooks/immutability */
      session.terminal.options.fontFamily =
        family;
      session.terminal.options.fontSize =
        appearance.fontSize;
      session.terminal.options.theme = theme;
      session.terminal.options.cursorStyle =
        appearance.cursorStyle;
      session.terminal.options.cursorBlink =
        appearance.cursorBlink;
      /* eslint-enable react-hooks/immutability */
      // 命令补全开关实时同步：关掉立即收起已显示的 ghost text
      session.completion.setEnabled(
        appearance.commandCompletion
      );
    }
    // 字号变化（Ctrl+滚轮或设置页）必然改列数：挂起 PTY 同步，手势
    // 停止 600ms 后恢复，避免连续缩放触发一串 ConPTY 整屏重绘
    //（那会把屏幕内容挤掉）。
    // 这里**要补一次同步**（flush=true），与面板开合不同：字符尺寸变了，
    // 远端必须按新列数排版，否则换行会全错。
    pausePtySync(600, true);
    resize();
  }, [
    appearance.fontFamily,
    appearance.fontSize,
    appearance.colorScheme,
    appearance.commandCompletion,
    appearance.cursorStyle,
    appearance.cursorBlink,
    appearance.webglRender,
    pausePtySync,
    resize,
    openedRef
  ]);

  /**
   * 回滚行数（scrollback）变化后，调整所有已打开终端的滚动缓冲区。
   *
   * xterm 的 `options.scrollback` 可以运行时赋值：调大立刻生效，
   * 调小则**丢弃最老的那部分历史行**（再调大也回不来）—— 这是用户
   * 自己在设置里选的，不额外确认。缓冲区大小不影响行列数，无需 resize。
   */
  useEffect(() => {
    for (const session of openedRef.current) {
      // 与字体/字号同一套路：xterm 只暴露可变的 options、没有 setter，
      // 改配置只能就地赋值（react-hooks/immutability 对第三方实例不适用）
      /* eslint-disable react-hooks/immutability */
      session.terminal.options.scrollback =
        appearance.scrollback;
      /* eslint-enable react-hooks/immutability */
    }
    console.debug(
      "[terminal] 回滚行数已应用",
      appearance.scrollback
    );
  }, [appearance.scrollback, openedRef]);
}
