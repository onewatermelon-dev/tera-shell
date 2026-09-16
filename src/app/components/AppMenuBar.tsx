import { Dropdown, Kbd } from "@heroui/react";

/**
 * 菜单项定义。
 *
 * `id` 同时是动作名：必须与 `AppHeader` 中 handlers 的键（即 `HeaderActions`
 * 的字段名）完全一致，否则点击会静默无响应。`shortcut` 只标注已真实生效的快捷键。
 */
export type MenuItemDef = {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
};

/** 单个菜单（文件 / 编辑 / 查看 / 工具）。 */
export type MenuDef = {
  id: string;
  label: string;
  items: MenuItemDef[];
};

/**
 * 菜单项的可用状态：由标题栏按当前会话状态传入。
 * 终端未打开时编辑类操作禁用，查找开关按当前搜索设置回显勾选。
 */
export type MenuState = {
  hasActive: boolean;
  hasSelection: boolean;
  caseSensitive: boolean;
  regex: boolean;
  maximized: boolean;
};

/**
 * 按当前状态构建四个菜单的内容。
 *
 * 只罗列已有实现支撑的项：尚未落地的能力（设置、关于）保留入口但置灰，
 * 避免点了没反应。快捷键同理，只有全局已绑定的才显示。
 */
export function buildMenus(
  state: MenuState
): MenuDef[] {
  const terminalReady = state.hasActive;
  return [
    {
      id: "file",
      label: "文件",
      items: [
        {
          id: "newSession",
          label: "新建 SSH 会话…"
        },
        {
          id: "openLocal",
          label: "打开本地终端"
        },
        {
          id: "closeActive",
          label: "关闭当前标签",
          disabled: !terminalReady
        },
        { id: "quit", label: "退出" }
      ]
    },
    {
      id: "edit",
      label: "编辑",
      items: [
        {
          id: "copy",
          label: "复制",
          shortcut: "Ctrl+C",
          disabled: !state.hasSelection
        },
        {
          id: "paste",
          label: "粘贴",
          shortcut: "Ctrl+V",
          disabled: !terminalReady
        },
        {
          id: "selectAll",
          label: "全选",
          disabled: !terminalReady
        },
        {
          id: "clear",
          label: "清屏",
          disabled: !terminalReady
        }
      ]
    },
    {
      id: "view",
      label: "查看",
      items: [
        {
          id: "find",
          label: "查找…",
          shortcut: "Ctrl+F"
        },
        {
          id: "toggleCaseSensitive",
          label: "区分大小写",
          checked: state.caseSensitive
        },
        {
          id: "toggleRegex",
          label: "正则表达式",
          checked: state.regex
        },
        {
          id: "toggleMaximize",
          label: state.maximized
            ? "还原窗口"
            : "最大化窗口"
        }
      ]
    },
    {
      id: "tools",
      label: "工具",
      items: [
        // SFTP 以当前活动会话为连接目标；没有会话时不置灰，
        // 点击后给出"请先打开一个会话"的提示（置灰会让人以为菜单坏了）
        {
          id: "openSftp",
          label: "SFTP 文件传输…"
        },
        {
          id: "devtools",
          label: "开发者工具",
          shortcut: "F12"
        },
        {
          id: "settings",
          label: "设置…",
          disabled: true
        }
      ]
    }
  ];
}

/**
 * 标题栏菜单栏：四个 HeroUI 下拉菜单，替代原先无响应的裸按钮。
 *
 * 触发器用 HeroUI 的 Dropdown.Trigger（本身即带按钮样式的 Button），
 * 不再额外嵌套 Button 以免出现 button 嵌套。
 */
export default function AppMenuBar({
  menus,
  onAction
}: {
  menus: MenuDef[];
  onAction: (id: string) => void;
}) {
  return (
    <nav
      className="main-menu"
      aria-label="应用菜单"
    >
      {menus.map(menu => (
        <Dropdown.Root key={menu.id}>
          <Dropdown.Trigger className="menu-trigger">
            {menu.label}
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label={menu.label}
              onAction={key =>
                onAction(String(key))
              }
            >
              {menu.items.map(item => (
                <Dropdown.Item
                  key={item.id}
                  id={item.id}
                  isDisabled={item.disabled}
                  textValue={item.label}
                >
                  <span className="menu-item-label">
                    {item.label}
                  </span>
                  {item.checked && (
                    <span
                      className="menu-item-check"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  )}
                  {item.shortcut && (
                    <Kbd className="menu-item-key">
                      {item.shortcut}
                    </Kbd>
                  )}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      ))}
    </nav>
  );
}
