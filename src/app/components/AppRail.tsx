import { Dropdown, Kbd } from "@heroui/react";
import {
  MenuOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  DashboardOutlined,
  ThunderboltOutlined
} from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import {
  useT,
  type Translator
} from "@/settings/lib/i18n";
import type { StatusMode } from "@/settings/lib/settings";

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
 * 只罗列已有实现支撑的项：尚未落地的能力保留入口但置灰，
 * 避免点了没反应。快捷键同理，只有全局已绑定的才显示。
 */
export function buildMenus(
  state: MenuState,
  t: Translator
): MenuDef[] {
  const terminalReady = state.hasActive;
  return [
    {
      id: "file",
      label: t("app.menu.file"),
      items: [
        {
          id: "newSession",
          label: t("app.menu.newSsh")
        },
        {
          id: "openLocal",
          label: t("app.menu.openLocal")
        },
        {
          id: "closeActive",
          label: t("app.menu.closeActive"),
          disabled: !terminalReady
        },
        { id: "quit", label: t("app.menu.quit") }
      ]
    },
    {
      id: "edit",
      label: t("app.menu.edit"),
      items: [
        {
          id: "copy",
          label: t("app.action.copy"),
          shortcut: "Ctrl+C",
          disabled: !state.hasSelection
        },
        {
          id: "paste",
          label: t("app.action.paste"),
          shortcut: "Ctrl+V",
          disabled: !terminalReady
        },
        {
          id: "selectAll",
          label: t("app.action.selectAll"),
          disabled: !terminalReady
        },
        {
          id: "clear",
          label: t("app.action.clear"),
          disabled: !terminalReady
        }
      ]
    },
    {
      id: "view",
      label: t("app.menu.view"),
      items: [
        {
          id: "find",
          label: t("app.menu.find"),
          shortcut: "Ctrl+F"
        },
        {
          id: "toggleCaseSensitive",
          label: t(
            "app.action.toggleCaseSensitive"
          ),
          checked: state.caseSensitive
        },
        {
          id: "toggleRegex",
          label: t("app.action.toggleRegex"),
          checked: state.regex
        },
        {
          id: "toggleMaximize",
          label: state.maximized
            ? t("app.menu.restore")
            : t("app.menu.maximize")
        }
      ]
    },
    {
      id: "tools",
      label: t("app.menu.tools"),
      items: [
        // SFTP 以当前活动会话为连接目标；没有会话时不置灰，
        // 点击后给出"请先打开一个会话"的提示（置灰会让人以为菜单坏了）
        {
          id: "openSftp",
          label: t("app.action.openSftp")
        },
        {
          id: "devtools",
          label: t("app.action.devtools"),
          shortcut: "F12"
        }
        // 设置入口固定在竖条底部的齿轮按钮，不在菜单里重复
      ]
    }
  ];
}

type RailProps = {
  menus: MenuDef[];
  onAction: (id: string) => void;
  /** 会话栏展开态与切换动作：竖条上的侧栏开关图标跟随它换图标与提示。 */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** 打开设置页。 */
  onOpenSettings: () => void;
  /** 底部状态栏形态（快捷宏 ⇆ 信息栏）与切换动作。 */
  statusMode: StatusMode;
  onToggleStatus: () => void;
};

/**
 * 左侧竖排菜单栏（VS Code 布局）：独立卡片 + 顶部汉堡按钮。
 *
 * 点击汉堡弹出竖排的一级菜单，每项向右弹子菜单 —— 一级项全部是
 * SubmenuTrigger，onAction 只会收到子菜单项的 id，与原水平菜单栏一致。
 * 汉堡下方依次是会话栏开关与状态栏形态开关，设置按钮固定在卡片最底部。
 */
export default function AppRail({
  menus,
  onAction,
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
  statusMode,
  onToggleStatus
}: RailProps) {
  const t = useT();
  return (
    <nav
      className="app-rail"
      aria-label={t("app.menu.aria")}
    >
      <>
        <Dropdown.Root>
          {/* 汉堡不能套 Hint：HeroUI Tooltip 的包装层会被 RAC press 判定为
              嵌套交互元素而吞掉点击，菜单打不开（外包内包都试过）——
              改用 CSS 悬停气泡（data-tip），外观对齐 Hint 的 .tooltip */}
          <Dropdown.Trigger
            className="rail-trigger rail-trigger--hint"
            aria-label={t("app.menu.aria")}
            data-tip={t("app.menu.aria")}
          >
            <MenuOutlined />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="right top">
            <Dropdown.Menu>
              {menus.map(menu => (
                <Dropdown.SubmenuTrigger
                  key={menu.id}
                >
                  <Dropdown.Item
                    textValue={menu.label}
                  >
                    <span className="menu-item-label">
                      {menu.label}
                    </span>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  {/* RAC 约定：SubmenuTrigger 第二个 child 必须是 Popover，Menu 才会弹成独立浮层 */}
                  <Dropdown.Popover placement="right top">
                    <Dropdown.Menu
                      onAction={key =>
                        onAction(String(key))
                      }
                    >
                      {menu.items.map(item => (
                        <Dropdown.Item
                          key={item.id}
                          id={item.id}
                          isDisabled={
                            item.disabled
                          }
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
                </Dropdown.SubmenuTrigger>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
        <Hint
          label={
            sidebarOpen
              ? t("sidebar.collapse")
              : t("sidebar.expand")
          }
        >
          <button
            type="button"
            className="rail-trigger"
            aria-label={
              sidebarOpen
                ? t("sidebar.collapse")
                : t("sidebar.expand")
            }
            onClick={onToggleSidebar}
          >
            {sidebarOpen ? (
              <MenuFoldOutlined />
            ) : (
              <MenuUnfoldOutlined />
            )}
          </button>
        </Hint>
        {/* 状态栏形态开关：图标指向点击后的形态（宏 ⇆ 信息） */}
        <Hint
          label={
            statusMode === "macros"
              ? t("status.toInfo")
              : t("status.toMacros")
          }
        >
          <button
            type="button"
            className="rail-trigger"
            aria-label={
              statusMode === "macros"
                ? t("status.toInfo")
                : t("status.toMacros")
            }
            onClick={onToggleStatus}
          >
            {statusMode === "macros" ? (
              <DashboardOutlined />
            ) : (
              <ThunderboltOutlined />
            )}
          </button>
        </Hint>
        {/* 设置按钮沉底：margin-top:auto 把它推到卡片最下面 */}
        <div className="rail-bottom">
          <Hint label={t("app.action.settings")}>
            <button
              type="button"
              className="rail-trigger"
              aria-label={t(
                "app.action.settings"
              )}
              onClick={onOpenSettings}
            >
              <SettingOutlined />
            </button>
          </Hint>
        </div>
      </>
    </nav>
  );
}
