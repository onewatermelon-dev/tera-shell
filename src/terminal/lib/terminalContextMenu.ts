import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClearOutlined,
  CodeOutlined,
  CopyOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FullscreenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
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
  onReconnect
}: TerminalMenuOptions) {
  let menu: HTMLDivElement | undefined;
  let copyItem: HTMLDivElement | undefined;
  let fullscreenItem: HTMLDivElement | undefined;
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
      const item = makeItem(
        label,
        checked ? "✓" : "",
        icon
      );
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

  function makeItem(
    label: string,
    shortcut: string,
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
    const key = document.createElement("kbd");
    key.className = "menu-key";
    key.textContent = shortcut;
    item.append(iconElement, name, key);
    return item;
  }

  /** 首次调用时构建菜单 DOM 并挂到 body；之后复用同一份。 */
  function ensure(): HTMLDivElement {
    if (menu) return menu;
    const element = document.createElement("div");
    element.className = "terminal-context-menu";

    const log = makeItem(
      "日志",
      "›",
      FileTextOutlined
    );
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
      "Ctrl+C",
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
      "Ctrl+V",
      SnippetsOutlined
    );
    paste.addEventListener("click", () => {
      navigator.clipboard
        .readText()
        .then(text => {
          if (text) target?.paste(text);
        })
        .catch(onError);
      hide();
      target?.focus();
    });

    const find = makeItem(
      "查找",
      "Ctrl+F",
      SearchOutlined
    );
    find.addEventListener("click", () => {
      hide();
      onFind();
    });

    // 断线后自动重连放弃时的兜底入口：未断线时点了也只是重新连一次
    const reconnect = makeItem(
      "重新连接",
      "",
      ReloadOutlined
    );
    reconnect.addEventListener("click", () => {
      hide();
      onReconnect(targetId);
      target?.focus();
    });

    const clear = makeItem(
      "清屏",
      "",
      ClearOutlined
    );
    clear.addEventListener("click", () => {
      target?.clear();
      hide();
      target?.focus();
    });

    const fullscreen = makeItem(
      "全屏",
      "",
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
      separator.cloneNode(),
      find,
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
