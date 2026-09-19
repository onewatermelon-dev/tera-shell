import type { Terminal } from "@xterm/xterm";

type TerminalMenuOptions = {
  /** 剪贴板操作失败时的上报出口 */
  onError: (reason: unknown) => void;
  /** 点击"查找"时打开搜索框 */
  onFind: () => void;
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
  onFind
}: TerminalMenuOptions) {
  let menu: HTMLDivElement | undefined;
  let copyItem: HTMLDivElement | undefined;
  let target: Terminal | undefined;

  function hide() {
    if (menu) menu.style.display = "none";
  }

  function makeItem(
    label: string,
    shortcut: string
  ) {
    const item = document.createElement("div");
    item.className = "menu-item";
    const name = document.createElement("span");
    name.textContent = label;
    const key = document.createElement("kbd");
    key.className = "menu-key";
    key.textContent = shortcut;
    item.append(name, key);
    return item;
  }

  /** 首次调用时构建菜单 DOM 并挂到 body；之后复用同一份。 */
  function ensure(): HTMLDivElement {
    if (menu) return menu;
    const element = document.createElement("div");
    element.className = "terminal-context-menu";

    const copy = makeItem("复制", "Ctrl+C");
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

    const paste = makeItem("粘贴", "Ctrl+V");
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

    const find = makeItem("查找", "Ctrl+F");
    find.addEventListener("click", () => {
      hide();
      onFind();
    });

    element.append(copy, paste, find);
    document.body.append(element);

    // 点击菜单外 / 按 Esc 关闭
    window.addEventListener(
      "mousedown",
      event => {
        if (
          !element.contains(event.target as Node)
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
    terminal: Terminal
  ) {
    event.preventDefault();
    event.stopPropagation();
    target = terminal;
    const element = ensure();
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
