/**
 * 文件栏的地址行：后退 / 前进、路径输入与本地路径选择、目录书签、刷新。
 *
 * 从 FilePane.tsx 拆出（2026-10-13）。输入框 + 下拉按钮 + 选择面板
 * 同处一层：面板与嵌在框内的按钮都以它为定位基准，宽度正好等于地址栏。
 */
import {
  CaretDownFilled,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  StarFilled,
  StarOutlined
} from "@ant-design/icons";
import {
  formatChord,
  shortcutOf
} from "@/shared/lib/appShortcuts";
import Hint from "@/shared/components/Hint";
import PathPicker, {
  type PlaceListing
} from "./PathPicker";
import BookmarkMenu from "./BookmarkMenu";

export function FilePanePathRow({
  label,
  trail,
  go,
  draft,
  onDraftChange,
  listingPath,
  busy,
  canPickPath,
  picker,
  onTogglePicker,
  onPickerSelect,
  onPickerClose,
  bookmarksOpen,
  onBookmarksOpenChange,
  bookmarks,
  bookmarked,
  onToggleBookmark,
  onRemoveBookmark,
  onOpen,
  onRefresh
}: {
  label: string;
  trail: { paths: string[]; cursor: number };
  go: (delta: number) => void;
  /** 输入框编辑草稿；null = 跟随当前目录 */
  draft: string | null;
  onDraftChange: (value: string | null) => void;
  listingPath: string | undefined;
  busy: boolean;
  /** 是否提供本地路径选择入口（本地栏 true；远程栏不显示按钮与面板） */
  canPickPath: boolean;
  /** 路径选择面板数据（null = 关着） */
  picker: PlaceListing | null;
  /** 开 / 关路径选择面板（父级负责加载根入口） */
  onTogglePicker: () => void;
  /** 选中一个本地路径：跳转并收起面板与草稿 */
  onPickerSelect: (path: string) => void;
  onPickerClose: () => void;
  bookmarksOpen: boolean;
  onBookmarksOpenChange: (open: boolean) => void;
  bookmarks: string[];
  bookmarked: boolean;
  onToggleBookmark: () => void;
  onRemoveBookmark: (path: string) => void;
  onOpen: (path: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="sftp-path-row">
      <Hint
        label={`后退 (${formatChord(shortcutOf("sftpGoBack") ?? "")})`}
      >
        <button
          type="button"
          className="path-nav-button"
          aria-label="上一步"
          disabled={trail.cursor <= 0}
          onClick={() => go(-1)}
        >
          <LeftOutlined />
        </button>
      </Hint>
      <Hint
        label={`前进 (${formatChord(shortcutOf("sftpGoForward") ?? "")})`}
      >
        <button
          type="button"
          className="path-nav-button"
          aria-label="下一步"
          disabled={
            trail.cursor < 0 ||
            trail.cursor >= trail.paths.length - 1
          }
          onClick={() => go(1)}
        >
          <RightOutlined />
        </button>
      </Hint>
      <div className="path-field">
        <input
          className="sftp-path"
          value={draft ?? listingPath ?? ""}
          placeholder={
            busy ? "连接中…" : "输入路径后回车"
          }
          spellCheck={false}
          onChange={event =>
            onDraftChange(event.target.value)
          }
          onKeyDown={event => {
            if (
              event.key === "Enter" &&
              draft?.trim()
            ) {
              onOpen(draft.trim());
              onDraftChange(null);
            }
          }}
        />
        {/* 只有本地栏提供路径选择；远程栏没有本地目录可挑。
            按钮嵌在输入框内部右端，图标为向下箭头（下拉语义） */}
        {canPickPath && (
          <button
            type="button"
            className="path-pick-button"
            aria-label="选择路径"
            onClick={onTogglePicker}
          >
            <CaretDownFilled />
          </button>
        )}
        {picker && (
          <PathPicker
            places={picker.places}
            icons={picker.icons}
            onSelect={onPickerSelect}
            onClose={onPickerClose}
          />
        )}
      </div>
      {/* 书签：星形实心=当前目录已收藏；点开面板可跳转 / 删除 */}
      <Hint label="目录书签">
        <button
          type="button"
          className="path-bookmark-button"
          aria-label="目录书签"
          disabled={!listingPath}
          onClick={() =>
            onBookmarksOpenChange(!bookmarksOpen)
          }
        >
          {bookmarked ? (
            <StarFilled className="is-on" />
          ) : (
            <StarOutlined />
          )}
        </button>
      </Hint>
      {bookmarksOpen && (
        <BookmarkMenu
          bookmarks={bookmarks}
          bookmarked={bookmarked}
          onToggleCurrent={onToggleBookmark}
          onJump={onOpen}
          onRemove={onRemoveBookmark}
          onClose={() =>
            onBookmarksOpenChange(false)
          }
        />
      )}
      {/* 刷新放在地址栏右侧（上一步/下一步在左端） */}
      <button
        type="button"
        className="path-refresh-button"
        aria-label={`${label}刷新`}
        disabled={busy || !listingPath}
        onClick={onRefresh}
      >
        <ReloadOutlined />
      </button>
    </div>
  );
}
