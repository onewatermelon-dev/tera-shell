import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn
} from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/domain/session";
import { registerTerminalLinks } from "@/utils/terminalLinks";

/**
 * 已经打开的终端会话。
 *
 * SavedSession 保存可持久化的连接配置；下面四个字段只在应用运行期间存在：
 * - terminal：负责终端渲染、键盘输入和 ANSI 转义序列解析的 xterm 实例。
 * - fit：根据容器尺寸计算终端的行数和列数。
 * - element：该终端专用的 DOM 容器，切换标签时会被移动到可见区域。
 * - mounted：记录 terminal.open() 是否执行过，避免对同一个 xterm 实例重复挂载。
 */
export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  mounted: boolean;
};

/**
 * 管理前端终端的完整生命周期。
 *
 * 数据流：
 * 1. 用户键盘输入 -> xterm onData -> Tauri terminal_write -> 后端 PTY。
 * 2. 后端 PTY 输出 -> Tauri terminal-output 事件 -> xterm.write()。
 * 3. 容器尺寸改变 -> ResizeObserver -> fit() -> Tauri terminal_resize。
 *
 * @param onError 由页面提供的统一错误处理函数，避免该组合式函数耦合具体提示组件。
 */
export function useTerminals(
  onError: (reason: unknown) => void
) {
  // 同时保持多个终端进程；数组顺序就是标签栏显示顺序。
  const opened = reactive<OpenSession[]>([]);
  // 只保存 id，当前会话通过 computed 从 opened 中派生，避免维护两份状态。
  const activeId = ref("");
  // TerminalWorkspace 提供的可见终端容器。
  const terminalHost = ref<HTMLElement>();
  const active = computed(() =>
    opened.find(
      session => session.id === activeId.value
    )
  );

  // Tauri 的 listen() 返回取消监听函数，组件卸载时必须逐个调用。
  let unlisteners: UnlistenFn[] = [];
  let resizeObserver: ResizeObserver | undefined;

  /**
   * 打开或激活一个会话。
   *
   * 同一个 session.id 只创建一个前端 xterm 和一个后端 PTY；再次点击会话时只切换标签。
   * 如果后端进程启动失败，会同步移除刚创建的前端标签，避免留下不可用的空会话。
   */
  async function open(session: SavedSession) {
    let current = opened.find(
      item => item.id === session.id
    );
    if (!current) {
      current = createTerminal(session);
      opened.push(current);
      try {
        await invoke("terminal_start", {
          config: session
        });
      } catch (reason) {
        opened.splice(opened.indexOf(current), 1);
        onError(reason);
        return;
      }
    }
    activeId.value = session.id;
    await mountActive();
  }

  /** 创建尚未挂载到页面的 xterm 实例，并建立“键盘输入 -> 后端 PTY”的通道。 */
  function createTerminal(
    session: SavedSession
  ): OpenSession {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: "#0b0e14",
        foreground: "#c9d1d9",
        cursor: "#6ee7b7",
        selectionBackground: "#2f4f46"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // SearchAddon 当前提供搜索能力基础；后续搜索框可直接调用其 findNext/findPrevious。
    terminal.loadAddon(new SearchAddon());
    // 给每个终端实例注册独立的 URL 提供器；识别、下划线和浏览器打开逻辑集中在工具模块中。
    registerTerminalLinks(terminal, onError);

    // onData 会收到普通字符、快捷键和控制序列，必须原样写入 PTY，不能自行解析。
    terminal.onData(data =>
      invoke("terminal_write", {
        id: session.id,
        data
      }).catch(onError)
    );
    // 返回 false 让 WebView 执行原生粘贴；xterm 会从 paste 事件读取剪贴板并触发 onData。
    terminal.attachCustomKeyEventHandler(
      event => {
        if (
          event.type !== "keydown" ||
          !event.ctrlKey ||
          event.key.toLowerCase() !== "v"
        )
          return true;
        return false;
      }
    );
    return {
      ...session,
      terminal,
      fit,
      element: document.createElement("div"),
      mounted: false
    };
  }

  /** 切换标签，不会创建或销毁后端终端进程。 */
  async function activate(id: string) {
    activeId.value = id;
    await mountActive();
  }

  /**
   * 将当前终端的 DOM 节点放入唯一可见的宿主容器。
   *
   * 每个终端保留自己的 element，切换标签时移动节点而不是重建 Terminal，
   * 因此滚动历史、光标位置和选择状态都能保留。
   */
  async function mountActive() {
    // 等待 Vue 根据 opened/activeId 更新 v-if 和 ref，否则 terminalHost 可能尚未出现。
    await nextTick();
    const current = active.value;
    if (!current || !terminalHost.value) return;
    current.element.className =
      "terminal-instance";
    terminalHost.value.replaceChildren(
      current.element
    );

    // terminal.open() 对每个实例只执行一次，后续切换只移动已经挂载的 DOM 节点。
    if (!current.mounted) {
      current.terminal.open(current.element);
      if (current.kind === "ssh") {
        current.terminal.writeln(
          "\x1b[38;5;244m密码输入不会显示字符或 *，输入完成后直接按 Enter。\x1b[0m"
        );
      }
      current.mounted = true;
    }

    resizeObserver?.observe(terminalHost.value);
    resize(current);
    current.terminal.focus();
  }

  /**
   * 同步浏览器容器尺寸和真实 PTY 尺寸。
   * fit() 先更新 xterm 的 rows/cols，再把结果发给后端；否则全屏程序可能绘制错位。
   */
  function resize(current = active.value) {
    if (!current) return;
    current.fit.fit();
    invoke("terminal_resize", {
      id: current.id,
      rows: current.terminal.rows,
      cols: current.terminal.cols
    }).catch(() => {});
  }

  /**
   * 关闭指定标签及其后端进程，并选择相邻标签作为新的活动会话。
   * dispose() 会释放 xterm 内部的事件监听器和渲染资源。
   */
  async function close(id: string) {
    const index = opened.findIndex(
      session => session.id === id
    );
    if (index < 0) return;
    await invoke("terminal_close", { id }).catch(
      onError
    );
    opened[index]?.terminal.dispose();
    opened.splice(index, 1);
    if (activeId.value === id)
      activeId.value =
        opened[Math.max(0, index - 1)]?.id || "";
    await mountActive();
  }

  onMounted(async () => {
    // 所有终端共用两个全局 Tauri 事件，通过 payload.id 路由到正确的 xterm 实例。
    unlisteners = await Promise.all([
      listen<{
        id: string;
        data: string;
      }>("terminal-output", ({ payload }) =>
        opened
          .find(({ id }) => id === payload.id)
          ?.terminal.write(payload.data)
      ),
      listen<string>(
        "terminal-exit",
        ({ payload }) =>
          opened
            .find(({ id }) => id === payload)
            ?.terminal.write(
              "\r\n\x1b[38;5;244m[会话已结束]\x1b[0m\r\n"
            )
      )
    ]);

    // 观察工作区变化，例如窗口缩放或侧边栏宽度变化。
    resizeObserver = new ResizeObserver(() =>
      resize()
    );
  });

  onBeforeUnmount(() => {
    // 防止页面重新挂载后重复接收输出，也避免 ResizeObserver 持有已销毁的 DOM。
    unlisteners.forEach(unlisten => unlisten());
    resizeObserver?.disconnect();
  });

  // 只暴露页面装配需要的状态和操作，xterm/Tauri 的实现细节保留在本文件中。
  return {
    opened,
    activeId,
    active,
    terminalHost,
    open,
    activate,
    close
  };
}
