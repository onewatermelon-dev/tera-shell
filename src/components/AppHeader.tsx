import {
  useEffect,
  useRef,
  useState
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@heroui/react";
import Hint from "@/components/Hint";
import {
  SettingOutlined,
  MoreOutlined,
  MinusOutlined,
  BorderOutlined,
  CloseOutlined
} from "@ant-design/icons";

// 无框窗口：原生标题栏被移除，最小化/最大化/关闭由这里接管。
export default function AppHeader() {
  const appWindow = useRef(getCurrentWindow());
  const [isMaximized, setIsMaximized] =
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

  return (
    <header
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
      <nav
        className="main-menu"
        aria-label="应用菜单"
      >
        {["文件", "编辑", "查看", "工具"].map(
          item => (
            <Button
              key={item}
              variant="ghost"
              size="sm"
            >
              {item}
            </Button>
          )
        )}
      </nav>
      <div className="title-actions">
        <Hint label="设置">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="设置"
          >
            <SettingOutlined />
          </Button>
        </Hint>
        <Hint label="更多">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="更多"
          >
            <MoreOutlined />
          </Button>
        </Hint>
        <div className="win-controls">
          <Hint label="最小化">
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label="最小化"
              onPress={() =>
                appWindow.current.minimize()
              }
            >
              <MinusOutlined />
            </Button>
          </Hint>
          <Hint
            label={
              isMaximized ? "还原" : "最大化"
            }
          >
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={
                isMaximized ? "还原" : "最大化"
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
                appWindow.current.close()
              }
            >
              <CloseOutlined />
            </Button>
          </Hint>
        </div>
      </div>
    </header>
  );
}
