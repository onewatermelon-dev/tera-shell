/**
 * 全局监听：终端输出/退出事件、终端层快捷键、ResizeObserver 与卸载清理。
 *
 * 从 useTerminals 搬出（2026-10-14 拆分）。整块只随挂载注册一次：
 * effect 依赖里的 search/resize/重连判定每渲染都可能变，走 ref 取最新值
 * —— 旧写法把 search 放进依赖，启动爆发期的连续重渲染会让 effect 反复
 * 重跑，而 cleanup 跑在 await listen 完成之前（此时列表还是空的），旧监听
 * 器成了孤儿：每个输出块被重复写进终端多次，表现为回显、提示符成双成对。
 *
 * ⚠️ ref 镜像的同步 effect 必须声明在监听 effect **之前**：同一提交里
 * effect 按声明顺序执行，先同步 ref、监听 effect 才拿得到最新值。
 * ⚠️ ResizeObserver 必须**同步**建好（不能排在 await 后面）：挂载用的
 * layout effect 会立刻 observe 宿主，排在 await 后那一次 observe 就打在
 * undefined 上，之后宿主尺寸变化再也没人触发 resize。
 */
import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn
} from "@tauri-apps/api/event";
import {
  DEVTOOLS_ALT_CHORD,
  matchChord,
  parseChord
} from "@/shared/lib/appShortcuts";
import type { useT } from "@/settings/lib/i18n";
import type { useTerminalSearch } from "@/terminal/lib/search/useTerminalSearch";
import { disableWebgl } from "@/terminal/lib/webglRenderer";
import type { OpenSession } from "./terminalTypes";
import { matchTerminalShortcut } from "./terminalInput";
import { isHostKeyError } from "./reconnect";

/**
 * 每个会话保留的输出尾部长度（字符）：够盖住 ssh 的密钥报错段落即可
 * （那几行总共不到 1KB），又不至于为长输出会话占内存。
 */
const OUTPUT_TAIL_LIMIT = 2048;

/** 往尾部缓冲追加输出，超长时砍掉头部。 */
function appendTail(
  tails: Map<string, string>,
  id: string,
  data: string
): void {
  const next = (tails.get(id) ?? "") + data;
  tails.set(
    id,
    next.length > OUTPUT_TAIL_LIMIT
      ? next.slice(-OUTPUT_TAIL_LIMIT)
      : next
  );
}

export function useTerminalGlobalListeners(options: {
  openedRef: RefObject<OpenSession[]>;
  disconnectedRef: RefObject<
    Record<string, boolean>
  >;
  setDisconnected: Dispatch<
    SetStateAction<Record<string, boolean>>
  >;
  /**
   * ResizeObserver 实例登记处：由这里创建并写入，挂载终端的
   * layout effect（在 useTerminals）读它 observe 宿主。
   * ⚠️ 名字必须带 Ref 后缀：react-hooks/immutability 只按命名识别
   * 「参数里的 ref」，否则 `xxx.current = ...` 的写入会被误判。
   */
  resizeObserverRef: RefObject<
    ResizeObserver | undefined
  >;
  /** resize 的 ref 镜像（来自 usePtyResizeSync）：observer 回调取最新值 */
  resizeRef: RefObject<
    (current?: OpenSession) => void
  >;
  /** 待发送的 PTY 尺寸同步定时器（来自 usePtyResizeSync）：卸载时作废 */
  ptyResizeTimers: RefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  handleDisconnect: (
    session: OpenSession | undefined,
    code: number | null | undefined
  ) => void;
  /** 取消全部待执行重连（组件卸载时调用） */
  cancelAllReconnects: () => void;
  search: ReturnType<typeof useTerminalSearch>;
  t: ReturnType<typeof useT>;
}) {
  const {
    openedRef,
    disconnectedRef,
    setDisconnected,
    resizeObserverRef,
    resizeRef,
    ptyResizeTimers,
    handleDisconnect,
    cancelAllReconnects,
    search,
    t
  } = options;

  const unlisteners = useRef<UnlistenFn[]>([]);
  /** 各会话的输出尾部（指纹变更检测用，见 reconnect.isHostKeyError） */
  const outputTailsRef = useRef(
    new Map<string, string>()
  );
  const documentShortcutHandler = useRef<
    ((event: KeyboardEvent) => void) | undefined
  >(undefined);
  const searchRef = useRef(search);
  const handleDisconnectRef = useRef(
    handleDisconnect
  );
  const tRef = useRef(t);
  // ref 镜像的同步 effect 要声明在监听 effect **之前**：同一提交里
  // effect 按声明顺序执行，先同步 ref、监听 effect 才拿得最新值
  useEffect(() => {
    searchRef.current = search;
    handleDisconnectRef.current =
      handleDisconnect;
    tRef.current = t;
  }, [search, handleDisconnect, t]);
  useEffect(() => {
    // cleanup 可能在不同的提交里执行，先把要清理的 ref 取值固定下来
    const ptyTimers = ptyResizeTimers.current;
    // ResizeObserver 必须**同步**建好：挂载用的 layout effect 会立刻 observe
    // 宿主，如果这里还排在 await 后面，那一次 observe 就打在 undefined 上，
    // 之后宿主尺寸变化再也没人触发 resize —— 本地与 PTY 尺寸永久脱节，
    // 表现就是远端按旧宽度换行、屏幕内容错位、提示符挤成一堆
    const observer = new ResizeObserver(() =>
      resizeRef.current()
    );
    resizeObserverRef.current = observer;
    let disposed = false;
    const setup = async () => {
      const listeners = await Promise.all([
        listen<{ id: string; data: string }>(
          "terminal-output",
          ({ payload }) => {
            // 拆分会话是独立会话，输出天然只写它自己这一只终端
            const session =
              openedRef.current.find(
                ({ id }) => id === payload.id
              );
            if (!session) return;
            // 指纹变更检测的样本：只存尾部，退出时查一次
            appendTail(
              outputTailsRef.current,
              payload.id,
              payload.data
            );
            // 先让补全识别备用屏切换（vim/top 等全屏应用期间不弹建议）
            session.completion.observeOutput(
              payload.data
            );
            session.terminal.write(payload.data);
          }
        ),
        listen<{
          id: string;
          code: number | null;
        }>("terminal-exit", ({ payload }) => {
          const { id, code } = payload;
          setDisconnected(prev => {
            const next = {
              ...prev,
              [id]: true
            };
            disconnectedRef.current = next;
            return next;
          });
          const session = openedRef.current.find(
            item => item.id === id
          );
          if (session) {
            session.terminal.options.cursorBlink = false;
            session.terminal.write(
              `\r\n\x1b[38;5;244m${tRef.current("terminal.exited")}\x1b[0m\r\n`
            );
          }
          // 密钥校验失败（指纹变更 / strict 下的未知主机）：ssh 也是 255
          // 退出，重连五次结果必然相同 —— 不重连，直接把报错点破，
          // 让用户知道要去核对指纹而不是等重连
          const tail =
            outputTailsRef.current.get(id) ?? "";
          outputTailsRef.current.delete(id);
          if (isHostKeyError(tail)) {
            if (session) {
              session.terminal.write(
                `\r\n\x1b[38;5;203m[${tRef.current(
                  "terminal.hostKeyError"
                )}]\x1b[0m\r\n`
              );
            }
            return;
          }
          // 只有 ssh 的连接错误（退出码 255）才自动重连：本地会话退出、
          // ssh 正常 exit 都是用户意图，就此收工
          handleDisconnectRef.current(
            session,
            code
          );
        })
      ]);
      // 挂载期的连续重渲染可能在 listen 完成前就跑过 cleanup：迟到的
      // 注册必须立刻注销，否则就是孤儿监听（输出被重复写入）
      if (disposed) {
        listeners.forEach(u => u());
        return;
      }
      unlisteners.current = listeners;
      documentShortcutHandler.current = (
        event: KeyboardEvent
      ) => {
        // ⚠️ **键位全部从生效表读**：这两个动作不在 AppHeader 的绑定
        // 范围里（handledElsewhere 跳过），这里是它们唯一的执行路径 ——
        // 硬编码会让用户在设置页的改动完全失效。
        if (
          matchTerminalShortcut(event, "find")
        ) {
          event.preventDefault();
          searchRef.current.openSearch();
          return;
        }
        // devtools 除生效键位（F12）外还认一个历史别名
        if (
          matchTerminalShortcut(
            event,
            "devtools"
          ) ||
          matchChord(
            event,
            parseChord(DEVTOOLS_ALT_CHORD)!
          )
        ) {
          event.preventDefault();
          invoke("open_devtools").catch(() => {});
        }
      };
      window.addEventListener(
        "keydown",
        documentShortcutHandler.current,
        true
      );
    };
    setup();
    return () => {
      disposed = true;
      unlisteners.current.forEach(u => u());
      unlisteners.current = [];
      observer.disconnect();
      // 待执行的重连定时器一并清掉：组件没了就不该再拉起 PTY
      cancelAllReconnects();
      // 待发送的 PTY 尺寸同步同样作废
      ptyTimers.forEach(timer =>
        clearTimeout(timer)
      );
      ptyTimers.clear();
      if (documentShortcutHandler.current)
        window.removeEventListener(
          "keydown",
          documentShortcutHandler.current,
          true
        );
      // ⚠️ 释放全部 WebGL context：浏览器对同时存活的 context 有上限，
      // 组件卸载（含 HMR、设置页切换导致的重挂）不清理的话，
      // context 会一直挂着直到达上限，之后新终端全拿不到 WebGL。
      // 读 openedRef.current（最新值）是故意的：要释放的是**卸载这一刻**
      // 仍开着的终端；挂载时列表是空的，照规则建议「进 effect 时拷贝」
      // 反而会一个都释放不到
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：必须读最新值
      for (const session of openedRef.current)
        disableWebgl(session.terminal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只随挂载注册一次，回调经 ref 取最新值（见上）
  }, []);
}
