import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AlertDialog,
  Button,
  Header
} from "@heroui/react";
import Hint from "@/shared/components/Hint";
import AppRail, {
  buildMenus,
  type MenuState
} from "@/app/components/AppRail";
import { useT } from "@/settings/lib/i18n";
import {
  APP_SHORTCUTS,
  handledElsewhere,
  isEditableTarget,
  matchAction
} from "@/shared/lib/appShortcuts";
import { refocusAfterAction } from "@/shared/lib/keepTerminalFocus";
import type { StatusMode } from "@/settings/lib/settings";
import {
  MinusOutlined,
  BorderOutlined,
  CloseOutlined
} from "@ant-design/icons";

/**
 * 菜单可执行的动作集合。
 *
 * 由 App 组装后整体传入：标题栏只负责派发 id，不关心会话/终端的具体实现。
 * 字段名必须与 AppMenuBar 里菜单项的 id 一致（id 即动作名）。
 */
export type HeaderActions = {
  newSession: () => void;
  openLocal: () => void;
  closeActive: () => void;
  find: () => void;
  toggleCaseSensitive: () => void;
  toggleRegex: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  clear: () => void;
  devtools: () => void;
  /** 重连当前活动会话（终端右键菜单「重新连接」的全局键位）。 */
  reconnect: () => void;
  /** 切换终端专注模式（隐藏侧栏/标签条/状态栏）。 */
  toggleFocusMode: () => void;
  /** 打开 SFTP 窗口，连接目标取当前活动会话。 */
  openSftp: () => void;
  /** 把当前会话与分组导出到 JSON 文件（文件菜单）。 */
  exportSessions: () => void;
  /** 从 JSON 文件导入会话，选完文件先弹确认框（文件菜单）。 */
  importSessions: () => void;
  /** 打开设置页。 */
  openSettings: () => void;
  /** 竖条菜单收起后的焦点回还（菜单动作多为终端操作）。 */
  refocusTerminal: () => void;
};

type Props = {
  actions: HeaderActions;
  /** 菜单项可用性：无活动终端、无选区时对应项置灰。 */
  menuState: MenuState;
  /** 会话栏展开态与切换动作：透传给左侧竖条上的开关图标。 */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** 底部状态栏形态（快捷宏 ⇆ 信息栏）：透传给左侧竖条上的开关。 */
  statusMode: StatusMode;
  onToggleStatus: () => void;
  /** 打开设置页时隐藏菜单入口 —— 那里的动作对设置页没有意义。 */
  hideMenus?: boolean;
  /** 菜单收起（动作执行或直接关闭）后的焦点回还回调。 */
  onMenuClosed: () => void;
};

// 无框窗口：原生标题栏被移除，最小化/最大化/关闭由这里接管。
export default function AppHeader({
  actions,
  menuState,
  sidebarOpen,
  onToggleSidebar,
  statusMode,
  onToggleStatus,
  hideMenus = false,
  onMenuClosed
}: Props) {
  const t = useT();
  const appWindow = useRef(getCurrentWindow());
  const [isMaximized, setIsMaximized] =
    useState(false);
  // 点击标题栏关闭钮先弹二次确认，确认后才真正关闭窗口
  const [confirmClose, setConfirmClose] =
    useState(false);
  const unlistenRef = useRef<
    (() => void) | undefined
  >(undefined);

  useEffect(() => {
    appWindow.current
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {});
    appWindow.current
      .onResized(() => {
        appWindow.current
          .isMaximized()
          .then(setIsMaximized)
          .catch(() => {});
      })
      .then(unlisten => {
        unlistenRef.current = unlisten;
      })
      .catch(() => {});
    return () => unlistenRef.current?.();
  }, []);

  const menus = useMemo(
    () => buildMenus(menuState, t),
    [menuState, t]
  );

  // 窗口级动作（退出走二次确认、最大化走窗口 API）不经过 App 传入的 actions。
  // 键名必须与 AppMenuBar 里菜单项的 id 完全一致，否则点击会静默无响应。
  const handlers: Record<string, () => void> = {
    ...actions,
    quit: () => setConfirmClose(true),
    toggleMaximize: () =>
      appWindow.current.toggleMaximize()
  };

  function runAction(id: string) {
    const handler = handlers[id];
    if (handler) {
      handler();
      // 菜单动作几乎都是针对终端的：收起后若焦点还留在竖条按钮上
      // 就还给终端（已导向搜索框/对话框/设置页则不打扰）
      refocusAfterAction(actions.refocusTerminal);
      return;
    }
    // 菜单项与动作未对齐时不再静默失败，控制台直接点名，避免"点了没反应"难排查
    console.warn(
      `[menu] 未实现的菜单动作：${id}`
    );
  }

  /**
   * 应用级快捷键。
   *
   * 键位与菜单标签读同一张表（`APP_SHORTCUTS`），所以改了表两边同步生效。
   *
   * 三条约束：
   *
   * 1. **在捕获阶段监听**（`capture: true`）：xterm 会吞掉一部分冒泡到
   *    窗口的按键，`Ctrl+F` 这类必须先于 xterm 拿到。
   *
   * 2. **`find` / `devtools` 跳过**（`handledElsewhere`）：它们在
   *    `useTerminals` 的挂载期监听里已经实现，这里再绑一次会触发两遍
   *    （`openSearch` 调两次、DevTools 开两个窗口）。
   *
   * 3. **可编辑元素聚焦时让路**（`isEditableTarget`）：AI 助手输入框里按
   *    `Ctrl+Shift+A` 应该是选文字，不是「终端全选」。终端（xterm 的辅助
   *    textarea）被显式排除在判断之外，它的键位另有一套。
   */
  const shortcutActionsRef = useRef(actions);
  /**
   * 完整 handlers（含本文件的 quit / toggleMaximize 两个窗口级动作）
   * 的 ref 镜像。经 ref 取，闭包只在挂载时建一次也不会拿到旧值。
   */
  const handlersRef = useRef(handlers);

  // ⚠️ **ref 只能在 effect 里同步，不能渲染期写**（react-hooks/refs 会报
  // "Cannot update ref during render"）：按键回调只在挂载时建一次，
  // 但要拿到最新的 handlers，就靠这里每次渲染后同步一次。
  useEffect(() => {
    shortcutActionsRef.current = actions;
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") return;
      // 可编辑元素聚焦时让路（AI 输入框里 Ctrl+Shift+A 应是选文字）
      if (isEditableTarget(event.target)) return;
      // 菜单已打开时不抢：方向键/回车要在菜单里正常导航
      const active = document.activeElement;
      if (active?.closest('[role="menu"]'))
        return;
      for (const id of Object.keys(
        APP_SHORTCUTS
      )) {
        // find / devtools 已在 useTerminals 里实现，这里再绑会触发两遍
        if (handledElsewhere(id)) continue;
        if (!matchAction(event, id)) continue;
        const handler = handlersRef.current[id];
        if (!handler) {
          // 表里有键位但没有对应实现：不静默，菜单项与动作脱节要能查
          console.warn(
            `[shortcut] ${id}（${APP_SHORTCUTS[id]}）没有对应实现`
          );
          return;
        }
        event.preventDefault();
        handler();
        refocusAfterAction(
          shortcutActionsRef.current
            .refocusTerminal
        );
        return;
      }
    };
    window.addEventListener(
      "keydown",
      onKeyDown,
      true
    );
    return () =>
      window.removeEventListener(
        "keydown",
        onKeyDown,
        true
      );
  }, []);

  return (
    <>
      {/* 左侧竖条与标题栏、工作区同属 .shell-app 的 grid，各占自己的 grid-area；
          设置页打开时整个竖条退出布局（见 .shell-app.settings-open） */}
      {!hideMenus && (
        <AppRail
          menus={menus}
          onAction={runAction}
          onMenuClosed={onMenuClosed}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={onToggleSidebar}
          onOpenSettings={actions.openSettings}
          statusMode={statusMode}
          onToggleStatus={onToggleStatus}
        />
      )}
      <Header
        className="titlebar"
        data-tauri-drag-region
      >
        <div
          className="brand"
          data-tauri-drag-region
        >
          <span className="brand-mark">T</span>
          <strong>Tera Shell</strong>
        </div>
        <div className="title-actions">
          <div className="win-controls">
            <Hint
              label={t("app.action.minimize")}
            >
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={t(
                  "app.action.minimize"
                )}
                onPress={() =>
                  appWindow.current.minimize()
                }
              >
                <MinusOutlined />
              </Button>
            </Hint>
            <Hint
              label={
                isMaximized
                  ? t("app.menu.restore")
                  : t("app.menu.maximize")
              }
            >
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={
                  isMaximized
                    ? t("app.menu.restore")
                    : t("app.menu.maximize")
                }
                onPress={() =>
                  appWindow.current.toggleMaximize()
                }
              >
                <BorderOutlined />
              </Button>
            </Hint>
            <Hint label="关闭">
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="关闭"
                className="win-close"
                onPress={() =>
                  setConfirmClose(true)
                }
              >
                <CloseOutlined />
              </Button>
            </Hint>
          </div>
        </div>

        <AlertDialog
          isOpen={confirmClose}
          onOpenChange={next => {
            if (!next) setConfirmClose(false);
          }}
        >
          <AlertDialog.Backdrop>
            <AlertDialog.Container placement="center">
              <AlertDialog.Dialog>
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    退出 Tera Shell？
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  所有终端会话将被关闭，未完成的命令会中断。
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    variant="tertiary"
                    size="sm"
                    onPress={() =>
                      setConfirmClose(false)
                    }
                  >
                    取消
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onPress={() =>
                      appWindow.current.close()
                    }
                  >
                    退出
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      </Header>
    </>
  );
}
