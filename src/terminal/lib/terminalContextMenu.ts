import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shortcutOf } from "@/shared/lib/appShortcuts";
import {
  AI_ASK_PRESETS,
  askAiFromTerminal,
  hasAiAskListener,
  resolveAskText
} from "@/terminal/lib/ai/askFromTerminal";
import {
  BugOutlined,
  ClearOutlined,
  CodeOutlined,
  CopyOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SnippetsOutlined,
  StopOutlined
} from "@ant-design/icons";

type LogStatus = {
  recording: boolean;
  paused: boolean;
  path: string | null;
  includeCodes: boolean;
};

type TerminalMenuOptions = {
  /** 剪贴板操作失败时的上报出口 */
  onError: (reason: unknown) => void;
  /** 点击"查找"时打开搜索框 */
  onFind: () => void;
  /** 点击"命令历史"时打开历史检索面板（与快捷键同一入口） */
  onHistory: () => void;
  /**
   * 粘贴一段文本到指定会话。
   *
   * ⚠️ 必须交给宿主判断，不能在这里直接 `terminal.paste()` ——
   * 粘贴防护要覆盖所有入口，右键是最容易被漏掉的那条。
   */
  onPaste: (
    sessionId: string,
    text: string
  ) => void;
  /** 点击"重新连接"时重连该会话（断线后自动重连放弃时的兜底入口） */
  onReconnect: (id: string) => void;
};

/**
 * 终端里的右键菜单（复制 / 粘贴 / 查找）。
 *
 * 用命令式 DOM 构建而不是 React 组件：菜单挂在 `body` 上、脱离终端网格的
 * 层叠与裁剪，定位只跟鼠标有关。文案与 HeroUI 菜单一致（标签左、快捷键右）。
 * 返回的对象自带 `show` / `hide`，内部记住当前操作的终端。
 */
export function createTerminalMenu({
  onError,
  onFind,
  onHistory,
  onPaste,
  onReconnect
}: TerminalMenuOptions) {
  let menu: HTMLDivElement | undefined;
  let copyItem: HTMLDivElement | undefined;
  let fullscreenItem: HTMLDivElement | undefined;
  /** 「解释这条 / 让 AI 看看」两项：show 时按有无可选内容置灰 */
  const askItems: HTMLDivElement[] = [];
  /** 本次右键要问 AI 的文本（选区优先，否则指针所在行） */
  let askText = "";
  let target: Terminal | undefined;
  let targetId = "";
  let logStatus: LogStatus = {
    recording: false,
    paused: false,
    path: null,
    includeCodes: false
  };
  let submenu: HTMLDivElement | undefined;
  let logPending = false;
  /**
   * 记下每个带键位的菜单项与它的动作 id，供 `refreshShortcuts` 刷新。
   * 菜单 DOM 只构建一次，用户改键位后要靠它在每次弹出时更新文字。
   */
  const shortcutBindings: {
    item: HTMLElement;
    actionId: string;
  }[] = [];

  function hide() {
    if (menu) menu.style.display = "none";
    if (submenu) submenu.style.display = "none";
  }

  /** 执行日志操作并刷新菜单状态。 */
  async function runLog(action: string) {
    if (logPending) return;
    logPending = true;
    hide();
    try {
      if (action === "start")
        await invoke("terminal_log_start", {
          id: targetId
        });
      else if (
        action === "file" ||
        action === "folder"
      ) {
        if (!logStatus.path) return;
        const path =
          action === "folder"
            ? logStatus.path.replace(
                /[\\/][^\\/]+$/,
                ""
              )
            : logStatus.path;
        await invoke("fs_open_path", { path });
      } else
        await invoke("terminal_log_action", {
          id: targetId,
          action
        });
      logStatus = await invoke<LogStatus>(
        "terminal_log_status",
        { id: targetId }
      );
    } catch (error) {
      onError(error);
    } finally {
      logPending = false;
      target?.focus();
    }
  }

  /** 按会话状态构建日志子菜单。 */
  function refreshLogMenu() {
    if (!submenu) return;
    submenu.replaceChildren();
    const add = (
      label: string,
      action: string,
      enabled: boolean,
      icon: typeof FileTextOutlined,
      checked = false
    ) => {
      // 子菜单各项传空串 id，不进 shortcutBindings —— 刷新时不会重复累积
      const item = makeItem(label, "", icon);
      if (checked) {
        const mark =
          document.createElement("kbd");
        mark.className = "menu-key";
        mark.textContent = "✓";
        item.append(mark);
      }
      item.classList.toggle("disabled", !enabled);
      item.addEventListener("click", event => {
        event.stopPropagation();
        if (enabled) void runLog(action);
      });
      submenu?.append(item);
    };
    const divider = () => {
      const line = document.createElement("div");
      line.className = "menu-separator";
      submenu?.append(line);
    };
    add(
      "开始记录...",
      "start",
      !logStatus.recording && !logPending,
      PlayCircleOutlined
    );
    add(
      "停止记录",
      "stop",
      logStatus.recording,
      StopOutlined
    );
    divider();
    add(
      "暂停",
      "pause",
      logStatus.recording && !logStatus.paused,
      PauseCircleOutlined
    );
    add(
      "继续",
      "resume",
      logStatus.recording && logStatus.paused,
      PlayCircleOutlined
    );
    divider();
    add(
      "打开日志文件",
      "file",
      !!logStatus.path,
      FileTextOutlined
    );
    add(
      "打开日志文件夹",
      "folder",
      !!logStatus.path,
      FolderOpenOutlined
    );
    divider();
    add(
      "包括终端代码",
      "codes",
      true,
      CodeOutlined,
      logStatus.includeCodes
    );
  }

  /**
   * 造一个菜单项。
   *
   * ⚠️ **`shortcut` 一律走 `shortcutOf(actionId)` 从快捷键表取**，
   * 不要在这里手写字符串：应用菜单（`AppRail`）与按键处理（`AppHeader`）
   * 读的是同一张表，这里再写一份就是第三份 —— 改键位必漂移。
   *
   * @param shortcutId 快捷键表里的动作 id；传 `""` 表示该项无快捷键
   *   （日志子菜单的各项、以及指向子菜单的「日志」本身）
   */
  function makeItem(
    label: string,
    shortcutId: string,
    icon: typeof FileTextOutlined
  ) {
    const item = document.createElement("div");
    item.className = "menu-item";
    const iconElement =
      document.createElement("span");
    iconElement.className = "menu-icon";
    iconElement.innerHTML = renderToStaticMarkup(
      createElement(icon)
    );
    const name = document.createElement("span");
    name.textContent = label;
    const chord = shortcutId
      ? (shortcutOf(shortcutId) ?? "")
      : "";
    // ⚠️ **有键位才建 <kbd>**：空元素靠 `margin-left:auto` 占位，
    // 会让「有键位」与「无键位」两行的标签起点看起来没对齐
    if (chord) {
      const key = document.createElement("kbd");
      key.className = "menu-key";
      key.textContent = chord;
      item.append(iconElement, name, key);
    } else {
      item.append(iconElement, name);
    }
    // 记下「这一项的键位来自哪个动作」：菜单 DOM 只构建一次并复用，
    // 用户改了键位后 show() 要靠它刷新 <kbd> 的文字
    if (shortcutId)
      shortcutBindings.push({
        item,
        actionId: shortcutId
      });
    return item;
  }

  /**
   * 每次弹出菜单前把 <kbd> 文字刷成**当前生效**的键位。
   *
   * ⚠️ 必须做：右键菜单的 DOM 在 `ensure()` 里只建一次，之后每次右键
   * 都复用同一份。用户中途改了快捷键（设置页），不刷的话菜单上
   * 一直写着旧键位，按新键又没反应 —— 典型的「界面在说谎」。
   */
  function refreshShortcuts() {
    for (const {
      item,
      actionId
    } of shortcutBindings) {
      const key = item.querySelector("kbd");
      if (!key) continue;
      key.textContent =
        shortcutOf(actionId) ?? "";
    }
  }

  /** 首次调用时构建菜单 DOM 并挂到 body；之后复用同一份。 */
  function ensure(): HTMLDivElement {
    if (menu) return menu;
    const element = document.createElement("div");
    element.className = "terminal-context-menu";

    // ⚠️ `makeItem` 第二参现在是**动作 id**（不是键位串），空串表示
    // 「无快捷键」。但「日志」这一项要显示子菜单箭头 `›` —— 它是
    // affordance 不是键位，所以走快捷键表查不到就手动填。
    const log = makeItem(
      "日志",
      "",
      FileTextOutlined
    );
    const logArrow =
      document.createElement("kbd");
    logArrow.className = "menu-key";
    logArrow.textContent = "›";
    log.append(logArrow);
    log.addEventListener("mouseenter", () => {
      if (!submenu) return;
      refreshLogMenu();
      const rect = log.getBoundingClientRect();
      submenu.style.visibility = "hidden";
      submenu.style.display = "block";
      submenu.style.left = `${rect.right + submenu.offsetWidth > window.innerWidth ? rect.left - submenu.offsetWidth : rect.right}px`;
      submenu.style.top = `${Math.min(rect.top, window.innerHeight - submenu.offsetHeight - 4)}px`;
      submenu.style.visibility = "visible";
    });
    submenu = document.createElement("div");
    submenu.className =
      "terminal-context-menu terminal-log-submenu";
    /** 只在离开主菜单与子菜单的整体范围时关闭。 */
    function hideOnLeave(event: MouseEvent) {
      const next = event.relatedTarget;
      if (
        !(next instanceof Node) ||
        (!element.contains(next) &&
          !submenu?.contains(next))
      )
        hide();
    }
    element.addEventListener(
      "mouseleave",
      hideOnLeave
    );
    submenu.addEventListener(
      "mouseleave",
      hideOnLeave
    );
    const separator =
      document.createElement("div");
    separator.className = "menu-separator";

    const copy = makeItem(
      "复制",
      "copy",
      CopyOutlined
    );
    copy.addEventListener("click", () => {
      if (!copy.classList.contains("disabled")) {
        navigator.clipboard
          .writeText(target?.getSelection() ?? "")
          .catch(onError);
      }
      hide();
      target?.focus();
    });
    copyItem = copy;

    const paste = makeItem(
      "粘贴",
      "paste",
      SnippetsOutlined
    );
    paste.addEventListener("click", () => {
      navigator.clipboard
        .readText()
        .then(text => {
          if (text) onPaste(targetId, text);
        })
        .catch(onError);
      hide();
      target?.focus();
    });

    // 「解释这条 / 让 AI 看看」：把选中的终端内容（或指针所在行）
    // 作为一轮提问送进 AI 面板，经 askFromTerminal 桥触达
    const askSeparator =
      document.createElement("div");
    askSeparator.className = "menu-separator";
    const makeAskItem = (
      preset: keyof typeof AI_ASK_PRESETS,
      icon: typeof QuestionCircleOutlined
    ) => {
      const item = makeItem(
        AI_ASK_PRESETS[preset].label,
        "",
        icon
      );
      item.addEventListener("click", () => {
        hide();
        // 内容或面板不可用时菜单项已置灰，这里双保险
        askAiFromTerminal(preset, askText);
        target?.focus();
      });
      askItems.push(item);
      return item;
    };
    const explain = makeAskItem(
      "explain",
      QuestionCircleOutlined
    );
    const diagnose = makeAskItem(
      "diagnose",
      BugOutlined
    );

    const find = makeItem(
      "查找",
      "find",
      SearchOutlined
    );
    find.addEventListener("click", () => {
      hide();
      onFind();
    });

    // 命令历史：与快捷键同一入口，默认只看本机（面板里可切到跨主机）
    const history = makeItem(
      "命令历史",
      "historySearch",
      HistoryOutlined
    );
    history.addEventListener("click", () => {
      hide();
      onHistory();
      target?.focus();
    });

    // 断线后自动重连放弃时的兜底入口：未断线时点了也只是重新连一次
    const reconnect = makeItem(
      "重新连接",
      "reconnect",
      ReloadOutlined
    );
    reconnect.addEventListener("click", () => {
      hide();
      onReconnect(targetId);
      target?.focus();
    });

    const clear = makeItem(
      "清屏",
      "clear",
      ClearOutlined
    );
    clear.addEventListener("click", () => {
      target?.clear();
      hide();
      target?.focus();
    });

    const fullscreen = makeItem(
      "全屏",
      "toggleFocusMode",
      FullscreenOutlined
    );
    fullscreenItem = fullscreen;
    fullscreen.addEventListener("click", () => {
      hide();
      document.body.classList.toggle(
        "terminal-focus"
      );
      target?.focus();
    });

    element.append(
      log,
      separator,
      copy,
      paste,
      askSeparator,
      explain,
      diagnose,
      separator.cloneNode(),
      find,
      history,
      separator.cloneNode(),
      reconnect,
      clear,
      separator.cloneNode(),
      fullscreen
    );
    element.addEventListener(
      "mouseover",
      event => {
        if (
          !log.contains(event.target as Node) &&
          submenu
        )
          submenu.style.display = "none";
      }
    );
    document.body.append(element, submenu);

    // 点击菜单外 / 按 Esc 关闭
    window.addEventListener(
      "mousedown",
      event => {
        if (
          !element.contains(
            event.target as Node
          ) &&
          !submenu?.contains(event.target as Node)
        ) {
          hide();
        }
      }
    );
    window.addEventListener(
      "keydown",
      event => {
        if (
          event.key === "Escape" &&
          element.style.display === "block"
        ) {
          hide();
          target?.focus();
        }
      },
      true
    );

    menu = element;
    return element;
  }

  /** 在鼠标位置弹出菜单；贴到窗口边缘时向回收。 */
  function show(
    event: MouseEvent,
    terminal: Terminal,
    id: string
  ) {
    event.preventDefault();
    event.stopPropagation();
    target = terminal;
    targetId = id;
    logStatus = {
      recording: false,
      paused: false,
      path: null,
      includeCodes: false
    };
    void invoke<LogStatus>(
      "terminal_log_status",
      { id }
    )
      .then(status => {
        if (targetId === id) {
          logStatus = status;
          refreshLogMenu();
        }
      })
      .catch(onError);
    const element = ensure();
    // 用户可能中途改过快捷键，弹出前把 <kbd> 刷成当前生效值
    refreshShortcuts();
    const fullscreenLabel =
      fullscreenItem?.children.item(1);
    if (fullscreenLabel)
      fullscreenLabel.textContent =
        document.body.classList.contains(
          "terminal-focus"
        )
          ? "退出全屏"
          : "全屏";
    // 没有选中内容时"复制"置灰
    copyItem?.classList.toggle(
      "disabled",
      !terminal.hasSelection() ||
        !terminal.getSelection().trim()
    );
    // 「解释这条 / 让 AI 看看」：解析本次要问的文本（选区优先，否则
    // 指针所在行），并按「有内容 + 有面板在听」置灰 —— 本地会话不挂
    // AiPanel，置灰好过点了没反应
    askText = resolveAskText(terminal, event);
    const askEnabled =
      askText.trim() !== "" && hasAiAskListener();
    for (const item of askItems)
      item.classList.toggle(
        "disabled",
        !askEnabled
      );
    element.style.visibility = "hidden";
    element.style.display = "block";
    const rect = element.getBoundingClientRect();
    element.style.left =
      Math.min(
        event.clientX,
        window.innerWidth - rect.width - 4
      ) + "px";
    element.style.top =
      Math.min(
        event.clientY,
        window.innerHeight - rect.height - 4
      ) + "px";
    element.style.visibility = "visible";
    terminal.focus();
  }

  return { show, hide };
}
