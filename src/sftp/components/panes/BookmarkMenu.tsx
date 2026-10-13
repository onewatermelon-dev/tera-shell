import { useEffect } from "react";
import {
  StarFilled,
  StarOutlined
} from "@ant-design/icons";

type BookmarkMenuProps = {
  /** 本栏可用的书签路径（已按侧与主机过滤）。 */
  bookmarks: string[];
  /** 当前目录是否已收藏（决定头部动作的文案与图标）。 */
  bookmarked: boolean;
  /** 收藏 / 取消收藏当前目录。 */
  onToggleCurrent: () => void;
  /** 跳转到某个书签。 */
  onJump: (path: string) => void;
  /** 删除某条书签。 */
  onRemove: (path: string) => void;
  onClose: () => void;
};

/**
 * 目录书签面板：头部一条「收藏 / 取消收藏当前目录」，下面列出
 * 本栏可跳转的书签，逐条可删。
 *
 * 与 PathPicker 同款交互：点面板外或 Esc 关闭。
 */
export default function BookmarkMenu({
  bookmarks,
  bookmarked,
  onToggleCurrent,
  onJump,
  onRemove,
  onClose
}: BookmarkMenuProps) {
  // 点击面板外或按 Esc 关闭
  useEffect(() => {
    const handlePointerDown = (
      event: MouseEvent
    ) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".bookmark-menu")) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener(
      "mousedown",
      handlePointerDown
    );
    document.addEventListener(
      "keydown",
      handleKey
    );
    return () => {
      document.removeEventListener(
        "mousedown",
        handlePointerDown
      );
      document.removeEventListener(
        "keydown",
        handleKey
      );
    };
  }, [onClose]);

  return (
    <div className="bookmark-menu">
      <button
        type="button"
        className="bookmark-toggle"
        onClick={() => {
          onToggleCurrent();
          onClose();
        }}
      >
        {bookmarked ? (
          <StarFilled className="bookmark-star is-on" />
        ) : (
          <StarOutlined className="bookmark-star" />
        )}
        {bookmarked
          ? "取消收藏当前目录"
          : "收藏当前目录"}
      </button>
      {bookmarks.length ? (
        <ul className="bookmark-items">
          {bookmarks.map(path => (
            <li
              key={path}
              className="bookmark-item"
            >
              <button
                type="button"
                className="bookmark-jump"
                title={path}
                onClick={() => {
                  onJump(path);
                  onClose();
                }}
              >
                {path}
              </button>
              <button
                type="button"
                className="bookmark-remove"
                aria-label={`删除书签 ${path}`}
                title="删除书签"
                onClick={() => onRemove(path)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bookmark-empty">暂无收藏</p>
      )}
    </div>
  );
}
