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
import AppMenuBar, {
  buildMenus,
  type MenuState
} from "@/app/components/AppMenuBar";
import { useT } from "@/settings/lib/i18n";
import {
  SettingOutlined,
  MoreOutlined,
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
  /** 打开 SFTP 窗口，连接目标取当前活动会话。 */
  openSftp: () => void;
  /** 打开设置页。 */
  openSettings: () => void;
};

type Props = {
  actions: HeaderActions;
  /** 菜单项可用性：无活动终端、无选区时对应项置灰。 */
  menuState: Omit<MenuState, "maximized">;
  /** 打开设置页时隐藏菜单栏 —— 那里的动作对设置页没有意义。 */
  hideMenus?: boolean;
};

// 无框窗口：原生标题栏被移除，最小化/最大化/关闭由这里接管。
export default function AppHeader({
  actions,
  menuState,
  hideMenus = false
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
    () =>
      buildMenus(
        {
          ...menuState,
          maximized: isMaximized
        },
        t
      ),
    [menuState, isMaximized, t]
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
      return;
    }
    // 菜单项与动作未对齐时不再静默失败，控制台直接点名，避免"点了没反应"难排查
    console.warn(
      `[menu] 未实现的菜单动作：${id}`
    );
  }

  return (
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
      {!hideMenus && (
        <AppMenuBar
          menus={menus}
          onAction={runAction}
        />
      )}
      <div className="title-actions">
        <Hint label={t("app.action.settings")}>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={t("app.action.settings")}
            onPress={actions.openSettings}
          >
            <SettingOutlined />
          </Button>
        </Hint>
        <Hint label={t("app.action.more")}>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={t("app.action.more")}
          >
            <MoreOutlined />
          </Button>
        </Hint>
        <div className="win-controls">
          <Hint label={t("app.action.minimize")}>
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
  );
}
