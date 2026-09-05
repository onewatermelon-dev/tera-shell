import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn
} from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/domain/session";
import {
  clearSearchTextOverlays,
  paintSearchTextOverlays,
  sweepStaleDecorations
} from "@/utils/searchTextOverlay";
import { registerTerminalLinks } from "@/utils/terminalLinks";
import {
  markSearchSelection,
  renderTextOnlySelection
} from "@/utils/terminalSelection";

/**
 * 已经打开的终端会话。
 *
 * SavedSession 保存可持久化的连接配置；下面四个字段只在应用运行期间存在：
 * - terminal：负责终端渲染、键盘输入和 ANSI 转义序列解析的 xterm 实例。
 * - fit：根据容器尺寸计算终端的行数和列数。
 * - element：该终端专用的 DOM 容器，切换标签时会被移动到可见区域。
 * - mounted：记录 terminal.open() 是否执行过，避免对同一个 xterm 实例重复挂载。
 * - sourceSessionId：标签来自的持久化会话 ID，双开标签也保留原 ID。
 */
export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  mounted: boolean;
  sourceSessionId: string;
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
  let documentShortcutHandler:
    ((event: KeyboardEvent) => void) | undefined;

  /**
   * 打开或激活一个会话。
   *
   * 同一个 session.id 只创建一个前端 xterm 和一个后端 PTY；再次点击会话时只切换标签。
   * 如果后端进程启动失败，会同步移除刚创建的前端标签，避免留下不可用的空会话。
   */
  async function open(
    session: SavedSession,
    sourceSessionId = session.id
  ) {
    let current = opened.find(
      item => item.id === session.id
    );
    if (!current) {
      current = createTerminal(
        session,
        sourceSessionId
      );
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

  /**
   * 多开一个相同配置的连接（双击侧边栏会话触发）。
   *
   * 生成全新的运行时 id 和标签名：第一个实例用原名，
   * 之后依次加 (2)(3) 后缀。只创建新的终端标签和后端 PTY，
   * 不写入持久化的会话列表。
   */
  async function duplicate(
    session: SavedSession
  ) {
    let n = 1;
    const nameAt = (i: number) =>
      i === 1
        ? session.name
        : `${session.name} (${i})`;
    while (
      opened.some(item => item.name === nameAt(n))
    )
      n++;
    await open(
      {
        ...session,
        id: `dup-${session.id}-${Date.now()}`,
        name: nameAt(n)
      },
      session.id
    );
  }

  // ---- 终端右键菜单 ----
  // 单例浮层挂在 body 上；菜单里操作的目标终端通过 contextmenu 事件传入。
  let contextMenu: HTMLDivElement | undefined;
  let menuCopyItem: HTMLDivElement;
  let menuTerminal: Terminal;

  /**
   * 确保终端右键菜单浮层存在，返回该菜单。
   *
   * 菜单是挂在 body 上的单例：无论打开多少个终端，共用一个浮层，
   * 操作目标通过 showContextMenu 传入。首次调用时创建 DOM 并注册
   * "点击菜单外 / Escape 关闭"的全局监听器。
   */
  function ensureContextMenu(): HTMLDivElement {
    if (contextMenu) return contextMenu;
    contextMenu = document.createElement("div");
    contextMenu.className =
      "terminal-context-menu";

    menuCopyItem = document.createElement("div");
    menuCopyItem.className = "menu-item";
    menuCopyItem.textContent = "复制 CTRL+C";
    menuCopyItem.addEventListener("click", () => {
      if (
        !menuCopyItem.classList.contains(
          "disabled"
        )
      )
        navigator.clipboard
          .writeText(menuTerminal.getSelection())
          .catch(onError);
      hideContextMenu();
      menuTerminal.focus(); // 菜单项点击抢走的焦点还给终端
    });

    const pasteItem =
      document.createElement("div");
    pasteItem.className = "menu-item";
    pasteItem.textContent = "粘贴 CTRL+V";
    pasteItem.addEventListener("click", () => {
      navigator.clipboard
        .readText()
        .then(text => {
          if (text) menuTerminal.paste(text);
        })
        .catch(onError);
      hideContextMenu();
      menuTerminal.focus(); // 粘贴后焦点回到终端，可直接继续输入
    });

    const findItem =
      document.createElement("div");
    findItem.className = "menu-item";
    findItem.textContent = "查找 CTRL+F";
    findItem.addEventListener("click", () => {
      hideContextMenu();
      openSearch();
    });

    contextMenu.append(
      menuCopyItem,
      pasteItem,
      findItem
    );
    document.body.append(contextMenu);

    // 点击菜单外或按 Escape 时关闭；mousedown 而非 click，避免与菜单项的 click 冲突。
    window.addEventListener(
      "mousedown",
      event => {
        if (
          contextMenu &&
          !contextMenu.contains(
            event.target as Node
          )
        )
          hideContextMenu();
      }
    );
    // 捕获阶段监听：焦点在终端时，Escape 会被 xterm 的 keydown 处理器
    // stopPropagation 截住，冒泡阶段到不了 window；捕获阶段先于目标执行，不受影响
    window.addEventListener(
      "keydown",
      event => {
        // 仅菜单打开时响应 Escape，避免平时按 Esc 抢走其他区域的焦点
        if (
          event.key === "Escape" &&
          contextMenu?.style.display === "block"
        ) {
          hideContextMenu();
          menuTerminal.focus();
        }
      },
      true
    );
    return contextMenu;
  }

  /**
   * 在鼠标位置显示终端右键菜单。
   *
   * @param event 原生 contextmenu 事件；阻止默认行为并停止冒泡，
   *              防止 WebView 原生菜单和 main.ts 的全局拦截抢先处理。
   * @param terminal 触发右键的终端实例，菜单的复制/粘贴都作用在它上面。
   */
  function showContextMenu(
    event: MouseEvent,
    terminal: Terminal
  ) {
    event.preventDefault();
    event.stopPropagation(); // 阻止冒泡到 main.ts 的全局拦截
    menuTerminal = terminal;
    const menu = ensureContextMenu();
    // 无选区、或选区全是空白（拖过行尾空白产生）时，复制置灰
    menuCopyItem.classList.toggle(
      "disabled",
      !terminal.hasSelection() ||
        !terminal.getSelection().trim()
    );
    // 先隐藏定位再量尺寸，避免菜单闪现；贴近视口边缘时向内收
    menu.style.visibility = "hidden";
    menu.style.display = "block";
    const rect = menu.getBoundingClientRect();
    menu.style.left =
      Math.min(
        event.clientX,
        window.innerWidth - rect.width - 4
      ) + "px";
    menu.style.top =
      Math.min(
        event.clientY,
        window.innerHeight - rect.height - 4
      ) + "px";
    menu.style.visibility = "visible";
    // 右键的 mousedown 会把焦点从 xterm 的 textarea 抢走，这里立即还给终端，
    // 保证菜单开着时键盘输入（Ctrl+C/V）仍然直达终端
    terminal.focus();
  }

  /** 隐藏右键菜单（保留 DOM，便于下次直接复用和测量尺寸）。 */
  function hideContextMenu() {
    if (contextMenu)
      contextMenu.style.display = "none";
  }

  // ---- 终端内搜索（封装 SearchAddon，UI 在 TerminalWorkspace）----
  const searchOpen = ref(false);
  const searchError = ref("");
  const searchCaseSensitive = ref(false);
  const searchRegex = ref(true);
  // 各会话的搜索结果按 id 存放；reactive 深层代理保证写入能触发更新
  const searchResults = reactive<
    Record<
      string,
      { index: number; count: number }
    >
  >({});

  /** 活动会话的搜索结果：index 是当前第几个（0 起），count 是总数。 */
  const searchResult = computed(
    () =>
      searchResults[active.value?.id ?? ""] ?? {
        index: -1,
        count: 0
      }
  );

  function openSearch() {
    searchError.value = "";
    searchOpen.value = true;
  }

  /**
   * 清除某会话的全部搜索视觉标记：命中背景和当前选区。
   */
  function clearSearchMarks(
    session: OpenSession
  ) {
    session.search.clearDecorations();
    clearSearchTextOverlays();
    session.terminal.clearSelection();
    session.terminal.refresh(
      0,
      session.terminal.rows - 1
    );
    sweepStaleDecorations(session.terminal);
  }

  function closeSearch() {
    searchOpen.value = false;
    searchError.value = "";
    const session = active.value;
    if (session) clearSearchMarks(session);
  }

  // 切换搜索选项后必须清掉 SearchAddon 的缓存搜索词：
  // findNext 先覆盖 lastSearchOptions 再判断"是否需重新高亮"，词不变选项变时
  // 会被误判为无需更新，导致开关不生效。clearDecorations 清缓存词后强制重算。
  function clearSearchCache() {
    const session = active.value;
    if (!session) return;
    clearSearchMarks(session);
    searchResults[session.id] = {
      index: -1,
      count: 0
    };
  }

  function toggleCaseSensitive() {
    searchCaseSensitive.value =
      !searchCaseSensitive.value;
    clearSearchCache();
  }

  function toggleRegex() {
    searchRegex.value = !searchRegex.value;
    clearSearchCache();
  }

  /** 命中项醒目底色，当前项用主题绿区分（xterm 要求 #RRGGBB）。 */
  const searchDecorations = {
    matchBackground: "#f2c94c",
    matchOverviewRuler: "#f2c94c",
    activeMatchBackground: "#ef4444",
    activeMatchColorOverviewRuler: "#ef4444"
  };

  /**
   * 在活动会话全文中查找，正则模式（不区分大小写）。
   * 非法正则只提示不执行；空查询清除高亮。
   *
   * @param query 搜索词（正则表达式）
   * @param direction next 向下 / prev 向上
   */
  function search(
    query: string,
    direction: "next" | "prev" | "input" = "next"
  ) {
    const current = active.value;
    if (!current) return;
    if (!query) {
      clearSearchMarks(current);
      searchResults[current.id] = {
        index: -1,
        count: 0
      };
      searchError.value = "";
      return;
    }
    if (searchRegex.value) {
      // 仅正则模式需要校验表达式
      try {
        new RegExp(query);
        searchError.value = "";
      } catch {
        searchError.value = "正则无效";
        return;
      }
    } else {
      searchError.value = "";
    }
    const options = {
      regex: searchRegex.value,
      caseSensitive: searchCaseSensitive.value,
      decorations: searchDecorations
    };
    // SearchAddon 会把当前命中项写入 xterm 选区；在触发选区变化前先标记
    // 其来源，使自定义选区覆盖层使用红色而非鼠标框选的青绿色。
    markSearchSelection(current.terminal);
    if (direction === "input")
      // 打字时原地扩展当前匹配，不向前跳，避免边输入边越过唯一匹配
      current.search.findNext(query, {
        ...options,
        incremental: true
      });
    else if (direction === "prev")
      current.search.findPrevious(query, options);
    else current.search.findNext(query, options);
    // 用可直接移除的 DOM 覆盖层显示黑色命中文字，不污染画布前景色。
    paintSearchTextOverlays(
      current.terminal,
      query,
      searchRegex.value,
      searchCaseSensitive.value
    );
    // SearchAddon 切换当前项和重建高亮时会批量销毁装饰，xterm 6 的装饰表
    // 惰性删除在同行多条目场景下会残留幽灵条目（见 searchTextOverlay.ts），
    // 必须在渲染前物理清除，否则黄色高亮会间接性丢失
    sweepStaleDecorations(current.terminal);
  }

  /**
   * 创建尚未挂载到页面的 xterm 实例和键盘输入通道。
   *
   * @param session 标签的运行时会话配置。
   * @param sourceSessionId 侧边栏中对应的持久化会话 ID。
   */
  function createTerminal(
    session: SavedSession,
    sourceSessionId: string
  ): OpenSession {
    const terminal = new Terminal({
      cursorBlink: true,
      // 搜索高亮（decorations）走 xterm proposed API（registerDecoration），必须开启
      allowProposedApi: true,
      fontFamily:
        '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: "#0b0e14",
        foreground: "#c9d1d9",
        cursor: "#6ee7b7",
        // 隐藏 xterm 原生的整行选区背景，由按实际文字宽度绘制的覆盖层替代。
        selectionBackground: "#00000000",
        selectionInactiveBackground: "#00000000",
        // xterm 6 的滚动条是自绘 DOM（VS Code ScrollableElement），
        // 颜色必须走主题 token；宽度/圆角在 app.scss 里覆盖
        scrollbarSliderBackground:
          "rgb(41 103 206)",
        scrollbarSliderHoverBackground:
          "rgb(41 103 206)",
        scrollbarSliderActiveBackground:
          "rgb(41 103 206)"
      }
    });
    // 每个终端保留自己的容器节点，切换标签时移动节点即可保留渲染和选区状态。
    const element = document.createElement("div");
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // 搜索：命中高亮用醒目底色，当前命中项用主题绿色区分。
    const search = new SearchAddon();
    terminal.loadAddon(search);
    // 搜索结果（第几个/共几个）写入按会话 id 索引的 reactive 记录
    search.onDidChangeResults(event => {
      searchResults[session.id] = {
        index: event.resultIndex,
        count: event.resultCount
      };
    });
    // 给每个终端实例注册独立的 URL 提供器；识别、下划线和浏览器打开逻辑集中在工具模块中。
    registerTerminalLinks(terminal, onError);
    // 原生选区继续负责复制；自定义覆盖层只绘制每行实际存在文字的部分。
    renderTextOnlySelection(terminal, element);

    // onData 会收到普通字符、快捷键和控制序列，必须原样写入 PTY，不能自行解析。
    terminal.onData(data =>
      invoke("terminal_write", {
        id: session.id,
        data
      }).catch(onError)
    );
    // Ctrl+C：有选区时复制并拦截（不发 SIGINT），无选区时照常中断进程。
    // Ctrl+V：返回 false 让 WebView 执行原生粘贴；xterm 会从 paste 事件读取剪贴板并触发 onData。
    terminal.attachCustomKeyEventHandler(
      event => {
        if (
          event.type !== "keydown" ||
          !event.ctrlKey
        )
          return true;
        const key = event.key.toLowerCase();
        if (key === "v") return false;
        // Ctrl+F 打开查找框；必须 preventDefault，否则 WebView 自带的
        // 页面查找栏也会弹出（返回 false 只阻止 xterm 处理，不阻止浏览器默认）
        if (key === "f") {
          event.preventDefault();
          openSearch();
          return false;
        }
        if (
          key === "c" &&
          terminal.hasSelection()
        ) {
          navigator.clipboard
            .writeText(terminal.getSelection())
            .catch(onError);
          return false;
        }
        return true;
      }
    );

    // 右键菜单只在终端元素上唤起；其他区域的 contextmenu 由 main.ts 全局拦截。
    element.addEventListener(
      "contextmenu",
      event => showContextMenu(event, terminal)
    );
    // 网格内拖过行尾空白产生的"纯空白选区"（复制出来只有空格）在松开鼠标时清除
    element.addEventListener("mouseup", () => {
      if (
        terminal.hasSelection() &&
        !terminal.getSelection().trim()
      )
        terminal.clearSelection();
    });
    return {
      ...session,
      // xterm 及其插件是类实例，放进 reactive 数组会被 Proxy 包裹，
      // SearchAddon.findNext 走 _core 私有 API 时会静默失效——markRaw 跳过代理
      terminal: markRaw(terminal),
      fit: markRaw(fit),
      search: markRaw(search),
      element: markRaw(element),
      mounted: false,
      sourceSessionId
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
    // 缩小窗口（行数变少）后 xterm 的视口不一定跟随光标，
    // 输入行会留在可视区下方；滚到底部保证输入行始终可见
    current.terminal.scrollToBottom();
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

    // 全局快捷键：浏览器级快捷键已在 Rust 侧禁用（AreBrowserAcceleratorKeysEnabled=false），
    // 这些键会到达页面，捕获阶段统一接管：
    // - Ctrl+F：路由到应用查找框（避免浏览器查找栏——不过已被原生禁用，这里是功能入口）
    // - F12 / Ctrl+Shift+I：打开 DevTools（原本由浏览器接管，禁用后需要手动调命令）
    documentShortcutHandler = (
      event: KeyboardEvent
    ) => {
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && key === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (
        event.key === "F12" ||
        (ctrl && event.shiftKey && key === "i")
      ) {
        event.preventDefault();
        invoke("open_devtools").catch(() => {});
      }
    };
    window.addEventListener(
      "keydown",
      documentShortcutHandler,
      true
    );
  });

  onBeforeUnmount(() => {
    // 防止页面重新挂载后重复接收输出，也避免 ResizeObserver 持有已销毁的 DOM。
    unlisteners.forEach(unlisten => unlisten());
    resizeObserver?.disconnect();
    if (documentShortcutHandler)
      window.removeEventListener(
        "keydown",
        documentShortcutHandler,
        true
      );
  });

  // 只暴露页面装配需要的状态和操作，xterm/Tauri 的实现细节保留在本文件中。
  return {
    opened,
    activeId,
    active,
    terminalHost,
    open,
    duplicate,
    activate,
    close,
    searchOpen,
    searchError,
    searchResult,
    searchCaseSensitive,
    searchRegex,
    openSearch,
    closeSearch,
    toggleCaseSensitive,
    toggleRegex,
    search
  };
}
