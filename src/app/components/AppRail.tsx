import { Dropdown, Kbd } from "@heroui/react";
import { keepTerminalFocus } from "@/shared/lib/keepTerminalFocus";
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
import { shortcutOf } from "@/shared/lib/appShortcuts";

/**
 * 菜单项定义。
 *
 * `id` 同时是动作名：必须与 `AppHeader` 中 handlers 的键（即 `HeaderActions`
 * 的字段名）完全一致，否则点击会静默无响应。`shortcut` 只标注已真实生效的快捷键。
 */
export type MenuItemDef = {
  id: string;
  label: string;
  /** 键位：留空则由 buildMenus 从 appShortcuts 表按 id 填。 */
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
 * 终端未打开时编辑类操作禁用，无选区时复制禁用。
 *
 * ⚠️ 这里只放**菜单真的读**的字段。查看菜单精简到只剩「查找」后，
 * `caseSensitive` / `regex`（查找面板自己的开关）与 `maximized`
 * （标题栏的窗口按钮）都不再是菜单项，字段一并删掉 ——
 * 留着会让 `menuState` 的 useMemo 白跑两次重渲染。
 */
export type MenuState = {
  hasActive: boolean;
  hasSelection: boolean;
};

/**
 * 按当前状态构建四个菜单的内容。
 *
 * 只罗列已有实现支撑的项：尚未落地的能力保留入口但置灰，
 * 避免点了没反应。快捷键同理，只有全局已绑定的才显示。
 *
 * ⚠️ **键位不在这里手写**：统一由 `shortcutOf(id)` 从
 * `appShortcuts` 表按动作 id 取（真正的按键处理在 AppHeader，
 * 也读同一张表）。菜单里手写一份、处理里再写一份必然漂移。
 */
export function buildMenus(
  state: MenuState,
  t: Translator
): MenuDef[] {
  const terminalReady = state.hasActive;
  /** 给菜单项补上键位（表里没有的留空，菜单就不显示那一列） */
  const withKey = (
    item: Omit<MenuItemDef, "shortcut"> & {
      shortcut?: string;
    }
  ): MenuItemDef => ({
    ...item,
    shortcut: item.shortcut ?? shortcutOf(item.id)
  });
  return [
    {
      id: "file",
      label: t("app.menu.file"),
      items: [
        withKey({
          id: "newSession",
          label: t("app.menu.newSsh")
        }),
        withKey({
          id: "openLocal",
          label: t("app.menu.openLocal")
        }),
        // 导入/导出走当前会话库：没有可导出内容时不置灰，
        // 点击后由 App 给出"没有可导出的会话"的提示。
        // 文案复用 transfer.* —— 同一件事，菜单与确认框不该有两种说法
        withKey({
          id: "exportSessions",
          label: t("transfer.export")
        }),
        withKey({
          id: "importSessions",
          label: t("transfer.import")
        }),
        withKey({
          id: "closeActive",
          label: t("app.menu.closeActive"),
          disabled: !terminalReady
        }),
        withKey({
          id: "quit",
          label: t("app.menu.quit")
        })
      ]
    },
    {
      id: "edit",
      label: t("app.menu.edit"),
      items: [
        withKey({
          id: "copy",
          label: t("app.action.copy"),
          disabled: !state.hasSelection
        }),
        withKey({
          id: "paste",
          label: t("app.action.paste"),
          disabled: !terminalReady
        }),
        withKey({
          id: "selectAll",
          label: t("app.action.selectAll"),
          disabled: !terminalReady
        }),
        withKey({
          id: "clear",
          label: t("app.action.clear"),
          disabled: !terminalReady
        })
      ]
    },
    {
      id: "view",
      label: t("app.menu.view"),
      // ⚠️ **这里只留「查找」**：区分大小写 / 正则两个开关在查找面板
      // 里各有一个按钮（`terminal.find.caseSensitive` 等），最大化走
      // 标题栏的窗口按钮 —— 菜单里再挂一遍是重复入口。
      // 它们的快捷键仍保留（`Ctrl+Shift+C` / `G` / `M`），见 appShortcuts。
      items: [
        withKey({
          id: "find",
          label: t("app.menu.find")
        })
      ]
    },
    {
      id: "tools",
      label: t("app.menu.tools"),
      items: [
        // SFTP 以当前活动会话为连接目标；没有会话时不置灰，
        // 点击后给出"请先打开一个会话"的提示（置灰会让人以为菜单坏了）
        withKey({
          id: "openSftp",
          label: t("app.action.openSftp")
        }),
        withKey({
          id: "devtools",
          label: t("app.action.devtools")
        })
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
  /** 竖条菜单收起（动作执行或直接关闭）后的焦点回还回调。 */
  onMenuClosed: () => void;
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
  onToggleStatus,
  onMenuClosed
}: RailProps) {
  const t = useT();
  return (
    <nav
      className="app-rail"
      aria-label={t("app.menu.aria")}
      // 点击竖条空白处不让焦点离开终端（按钮区域除外）：mousedown 阶段
      // 阻止默认行为，click 照常触发，终端光标保持闪烁
      onMouseDown={keepTerminalFocus}
    >
      <>
        <Dropdown.Root
          // 菜单收起（执行了动作或直接关闭）后把焦点还给终端
          onOpenChange={open => {
            if (!open) onMenuClosed();
          }}
        >
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
