type SftpDockProps = {
  /** 所有打开的 SFTP 窗口（顺序即标签顺序） */
  windows: { id: string; label: string }[];
  /** 当前显示在前台的窗口 id */
  activeId: string | null;
  /** 切换前台窗口 */
  onSelect: (id: string) => void;
  /** 关闭某个窗口 */
  onCloseWindow: (id: string) => void;
};

/**
 * SFTP 窗口标签栏（贴在窗口底部）。
 *
 * 多个窗口都是全屏 Modal 叠加，视觉上只能看到最上面那个，
 * 所以需要这条常驻的横条来暴露"一共开了几个"，并提供相互切换的入口。
 * 只有一个窗口时不渲染，免得占地方。
 */
export default function SftpDock({
  windows,
  activeId,
  onSelect,
  onCloseWindow
}: SftpDockProps) {
  if (windows.length < 2) return null;

  return (
    <div className="sftp-dock">
      {windows.map((item, index) => (
        <div
          key={item.id}
          className={
            item.id === activeId
              ? "sftp-dock-window is-active"
              : "sftp-dock-window"
          }
        >
          <button
            type="button"
            className="sftp-dock-main"
            onClick={() => onSelect(item.id)}
          >
            <span className="sftp-dock-index">
              #{index + 1}
            </span>
            <span className="sftp-dock-name">
              {item.label}
            </span>
          </button>
          <button
            type="button"
            className="sftp-dock-close"
            aria-label={`关闭窗口 ${index + 1}`}
            onClick={() => onCloseWindow(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
