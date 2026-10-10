import { memo, useState } from "react";
import {
  CaretDownFilled,
  FolderOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined
} from "@ant-design/icons";
import {
  EmptyState,
  Surface,
  Typography
} from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import type {
  PaneEntry,
  PaneListing,
  PaneSide
} from "@/sftp/lib/useSftp";
import PathPicker, {
  type PlaceListing
} from "@/sftp/components/PathPicker";
import FileContextMenu, {
  type FileAction
} from "@/sftp/components/FileContextMenu";
import NewEntryDialog from "@/sftp/components/NewEntryDialog";
import RenameDialog from "@/sftp/components/RenameDialog";
import ChmodDialog from "@/sftp/components/ChmodDialog";
import EntryIcon from "@/sftp/components/EntryIcon";
import ConfirmDialog from "@/shared/components/ConfirmDialog";
import Hint from "@/shared/components/Hint";
import {
  formatPerm,
  formatSize,
  formatTime
} from "@/sftp/lib/fileFormat";
import {
  nextSelection,
  resolveSelected
} from "@/sftp/lib/sftpUtils";

type FilePaneProps = {
  label: string;
  listing: PaneListing | null;
  error: string;
  busy: boolean;
  /** 目录为空（或未连接）时的提示文案。 */
  emptyText: string;
  onOpen: (path: string) => void;
  /** 强制重新读取当前目录（远程会跳过后端缓存）。 */
  onRefresh: () => void;
  /** 是否提供本地路径选择入口（本地栏 true；远程栏不显示按钮与面板）。 */
  canPickPath?: boolean;
  /** 是否本地栏：决定右键菜单里"打开 / 用记事本打开"是否可用 */
  isLocal: boolean;
  /** 剪贴板里是否有可粘贴的内容 */
  canPaste: boolean;
  /** 右键菜单动作；entry 为右键点中的条目（空白处 null），entries
   * 是本次作用的完整条目集（多选时为整个选中，否则只含 entry 一项） */
  onContextAction: (
    action: FileAction,
    entry: PaneEntry | null,
    entries: PaneEntry[]
  ) => void;
  /** 新建对话框确认后创建文件夹 / 文件 */
  onCreate: (
    isDir: boolean,
    name: string
  ) => void;
  /** 重命名确认（只给新名称，目标路径由父级按当前目录拼） */
  onRename: (
    entry: PaneEntry,
    name: string
  ) => void;
  /** 权限修改确认（菜单里只有远程栏会出现该项，本地栏不传）；多选时整批生效 */
  onChmod?: (
    entries: PaneEntry[],
    mode: number
  ) => void;
  /** 本栏是哪一侧 —— 拖拽跨栏判定与 DOM 属性都要用 */
  side: PaneSide;
  /** 行按下：起手拖拽。整行可拖，不另设手柄 */
  onDragStart: (
    side: PaneSide,
    entries: PaneEntry[],
    event: React.PointerEvent<HTMLElement>
  ) => void;
  /** 该行是否正被拖走（压暗，让用户看清从哪儿来） */
  isDragging?: (path: string) => boolean;
  /** 该条目是否是当前落点（目录高亮成"放这里"） */
  isTarget?: (path: string) => boolean;
  /** 整栏是否是当前落点栏（描边提示） */
  isPaneTarget?: boolean;
};

/**
 * 单侧文件列表：本地与远程共用同一个组件。
 *
 * 两边因此必然使用相同的图标、相同的列结构与双击进入交互。
 * 表头用 `position: sticky` 固定在滚动容器顶部（与行同处一个容器，
 * 列宽天然对齐，不必手动补偿滚动条宽度）。
 *
 * 导航历史、右键菜单与各类对话框的开关都是本组件的内部状态；
 * 真正的文件操作由父级通过回调派发出去。
 */
const FilePane = memo(function FilePane({
  label,
  listing,
  error,
  busy,
  emptyText,
  onOpen,
  onRefresh,
  canPickPath = false,
  isLocal,
  canPaste,
  onContextAction,
  onCreate,
  onRename,
  onChmod,
  side,
  onDragStart,
  isDragging,
  isTarget,
  isPaneTarget = false
}: FilePaneProps) {
  // 导航历史：paths 是走过的目录序列，cursor 指向当前那一项。
  // 后退 / 前进只移动 cursor，不新增记录；新导航会截断 cursor 之后的分叉。
  const [trail, setTrail] = useState<{
    paths: string[];
    cursor: number;
  }>({ paths: [], cursor: -1 });
  // 已经记入历史的路径，用于判断当前目录是不是新目录
  const [recorded, setRecorded] = useState<
    string | null
  >(null);
  // 多选：选中路径集合 + Shift 范围选择的锚点。
  // 只存路径，动作时映射回当前列表（自动滤掉已消失的路径）
  const [selected, setSelected] = useState<
    Set<string>
  >(new Set());
  const [anchor, setAnchor] = useState<
    string | null
  >(null);
  // 目录内过滤：实时筛选当前列表（纯前端），换目录时清空
  const [filter, setFilter] = useState("");

  // 父级加载成功的目录纳入历史（首屏、外部改路径都走这里）。
  // 这是渲染期间依据 props 调整 state（React 允许的模式），不需要 effect。
  if (
    listing?.path &&
    listing.path !== recorded
  ) {
    setRecorded(listing.path);
    // 换了目录，旧选中与过滤词已无意义
    setSelected(new Set());
    setAnchor(null);
    setFilter("");
    setTrail(previous => {
      const kept = previous.paths.slice(
        0,
        previous.cursor + 1
      );
      // 同一路径不重复记录（后退/前进回到旧目录时会走到这里）
      if (
        kept[kept.length - 1] === listing.path
      ) {
        return previous;
      }
      kept.push(listing.path);
      return {
        paths: kept,
        cursor: kept.length - 1
      };
    });
  }

  /** 后退（-1）/ 前进（+1）：只挪指针，历史本身不动。 */
  function go(delta: number) {
    const next =
      trail.paths[trail.cursor + delta];
    if (!next) return;
    setTrail(previous => ({
      ...previous,
      cursor: previous.cursor + delta
    }));
    onOpen(next);
  }

  // 输入框的编辑草稿：null 表示"跟随当前目录"，导航成功后回到跟随模式
  const [draft, setDraft] = useState<
    string | null
  >(null);
  // 路径选择面板：点开时才加载根入口（事件回调里取数，不需要 effect）
  const [picker, setPicker] =
    useState<PlaceListing | null>(null);

  async function openPicker() {
    try {
      setPicker(
        await invoke<PlaceListing>("fs_places")
      );
    } catch {
      setPicker(null);
    }
  }

  // 右键菜单：坐标 + 点中的条目（空白处为 null）+ 作用条数
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: PaneEntry | null;
    count: number;
  } | null>(null);
  // 新建对话框：点菜单里的"新建"时打开
  const [creating, setCreating] = useState(false);
  // 待删除的条目：非空时弹出二次确认（多选时为整批）
  const [pendingDelete, setPendingDelete] =
    useState<PaneEntry[] | null>(null);
  // 待重命名的条目：非空时弹出重命名对话框（只对单条有效）
  const [renameTarget, setRenameTarget] =
    useState<PaneEntry | null>(null);
  // 待改权限的条目：非空时弹出权限对话框（仅远程栏会出现；多选整批）
  const [chmodTarget, setChmodTarget] = useState<
    PaneEntry[] | null
  >(null);

  // 上级目录：列表顶部固定一项 ".." 用于回到它
  const parent = listing?.parent ?? null;
  // 两栏列结构不同：本地没有 Unix 权限与所有者
  const gridClass = isLocal
    ? "file-grid--local"
    : "file-grid--remote";

  /** 行主键按下后的选中集合变化（普通 / Ctrl / Shift 三种语义）。 */
  function selectOnPointerDown(
    entry: PaneEntry,
    event: React.PointerEvent
  ) {
    if (event.button !== 0) return;
    const paths =
      listing?.entries.map(e => e.path) ?? [];
    setSelected(
      nextSelection(selected, paths, entry.path, {
        ctrl: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
        anchor
      })
    );
    // Shift 保持锚点不动，普通 / Ctrl 点击把锚点挪到当前行
    if (!event.shiftKey) setAnchor(entry.path);
  }

  /** 拖拽要带的条目：按住已选中的一行拖走 = 拖整个选中。 */
  function dragEntries(
    entry: PaneEntry
  ): PaneEntry[] {
    const picked = resolveSelected(
      listing?.entries ?? [],
      selected
    );
    return selected.has(entry.path) &&
      picked.length > 1
      ? picked
      : [entry];
  }

  /** 清空选中（点空白 / Esc / 导航 / 批量动作派发后）。 */
  function clearSelection() {
    setSelected(new Set());
    setAnchor(null);
  }

  // 过滤后的可见条目：文件名大小写不敏感子串匹配。
  // ".." 回上级不受过滤影响；选中集仍按完整列表解析
  const keyword = filter.trim().toLowerCase();
  const allEntries = listing?.entries ?? [];
  const visibleEntries = keyword
    ? allEntries.filter(entry =>
        entry.name.toLowerCase().includes(keyword)
      )
    : allEntries;

  /** 当前菜单作用的完整条目集：右键落在多选里 = 整个选中，否则就它一个。 */
  const menuEntries =
    menu?.entry &&
    menu.count > 1 &&
    selected.has(menu.entry.path)
      ? resolveSelected(
          listing?.entries ?? [],
          selected
        )
      : menu?.entry
        ? [menu.entry]
        : [];

  return (
    <Surface
      className="sftp-pane"
      // 拖拽落点靠这三个属性定位：栏身份、栏当前目录（落点默认位置）。
      // React 会省略空串属性，所以路径为空时不能指望这个属性存在 ——
      // probeDrop 读不到就当无效落点，不会误传方向。
      data-pane-side={side}
      data-pane-path={listing?.path ?? ""}
      data-pane-target={isPaneTarget || undefined}
    >
      <div className="sftp-pane-head">
        <span className="sftp-pane-title">
          {label}
          {busy && (
            <em className="pane-busy">载入中…</em>
          )}
          {selected.size > 1 && (
            <em className="pane-busy">
              已选 {selected.size} 项
            </em>
          )}
        </span>
        {/* 目录内过滤框：输入即筛选，Esc 或 × 清空 */}
        <span className="pane-filter-wrap">
          <input
            className="pane-filter"
            value={filter}
            placeholder="过滤当前目录"
            spellCheck={false}
            onChange={event =>
              setFilter(event.target.value)
            }
            onKeyDown={event => {
              if (event.key === "Escape") {
                setFilter("");
                event.currentTarget.blur();
              }
            }}
          />
          {filter && (
            <button
              type="button"
              className="pane-filter-clear"
              aria-label="清除过滤"
              onClick={() => setFilter("")}
            >
              ×
            </button>
          )}
        </span>
      </div>
      <div className="sftp-path-row">
        <Hint label="后退 (Alt+←)">
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
        <Hint label="前进 (Alt+→)">
          <button
            type="button"
            className="path-nav-button"
            aria-label="下一步"
            disabled={
              trail.cursor < 0 ||
              trail.cursor >=
                trail.paths.length - 1
            }
            onClick={() => go(1)}
          >
            <RightOutlined />
          </button>
        </Hint>
        {/* 输入框 + 下拉按钮 + 选择面板同处这一层：
            面板与嵌在框内的按钮都以它为定位基准，宽度正好等于地址栏 */}
        <div className="path-field">
          <input
            className="sftp-path"
            value={draft ?? listing?.path ?? ""}
            placeholder={
              busy ? "连接中…" : "输入路径后回车"
            }
            spellCheck={false}
            onChange={event =>
              setDraft(event.target.value)
            }
            onKeyDown={event => {
              if (
                event.key === "Enter" &&
                draft?.trim()
              ) {
                onOpen(draft.trim());
                setDraft(null);
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
              onClick={() => {
                if (picker) setPicker(null);
                else void openPicker();
              }}
            >
              <CaretDownFilled />
            </button>
          )}
          {picker && (
            <PathPicker
              places={picker.places}
              icons={picker.icons}
              onSelect={path => {
                onOpen(path);
                setPicker(null);
                setDraft(null);
              }}
              onClose={() => setPicker(null)}
            />
          )}
        </div>
        {/* 刷新放在地址栏右侧（上一步/下一步在左端） */}
        <button
          type="button"
          className="path-refresh-button"
          aria-label={`${label}刷新`}
          disabled={busy || !listing}
          onClick={onRefresh}
        >
          <ReloadOutlined />
        </button>
      </div>
      <div
        className="sftp-file-list"
        // 可聚焦：点击行后焦点落在这里，Ctrl+A / Delete / F2 才有落点
        tabIndex={0}
        onKeyDown={event => {
          if (!allEntries.length) return;
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "a"
          ) {
            // 全选要拦下浏览器默认的文本选择；
            // 过滤生效时只选可见的，别把看不见的一起带上
            event.preventDefault();
            setSelected(
              new Set(
                visibleEntries.map(e => e.path)
              )
            );
          } else if (event.key === "Escape") {
            clearSelection();
          } else if (
            event.altKey &&
            event.key === "ArrowLeft"
          ) {
            // 后退 / 前进与按钮同一入口（go 内部自带越界保护）
            event.preventDefault();
            go(-1);
          } else if (
            event.altKey &&
            event.key === "ArrowRight"
          ) {
            event.preventDefault();
            go(1);
          } else if (event.key === "Delete") {
            const picked = resolveSelected(
              allEntries,
              selected
            );
            if (picked.length)
              setPendingDelete(picked);
          } else if (
            event.key === "F2" &&
            selected.size === 1
          ) {
            const [only] = resolveSelected(
              allEntries,
              selected
            );
            if (only) setRenameTarget(only);
          }
        }}
        onClick={event => {
          // 点在行外（空白 / 滚动条）：清空选中
          if (
            !(
              event.target as HTMLElement
            ).closest(".file-row")
          ) {
            clearSelection();
          }
        }}
        onContextMenu={event => {
          // 空白处右键：菜单里只有"新建 / 粘贴"可用
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            entry: null,
            count: 1
          });
        }}
      >
        <div className={`file-head ${gridClass}`}>
          <span>名称</span>
          <span className="cell-end">大小</span>
          {!isLocal && <span>权限</span>}
          {!isLocal && <span>所有者</span>}
          <span>修改时间</span>
        </div>
        {error ? (
          <Typography.Paragraph
            size="sm"
            className="dialog-error pane-message"
          >
            {error}
          </Typography.Paragraph>
        ) : (
          <>
            {/* 列表顶部固定一项 ".."，双击回到上级目录 */}
            {parent && (
              <div
                className="file-row"
                onDoubleClick={() =>
                  onOpen(parent)
                }
              >
                <span className="cell-name">
                  {listing?.icons?.dir ? (
                    <img
                      className="file-icon"
                      src={listing.icons.dir}
                      alt=""
                    />
                  ) : (
                    <FolderOutlined />
                  )}
                  <span className="file-name">
                    ..
                  </span>
                </span>
              </div>
            )}
            {visibleEntries.length ? (
              visibleEntries.map(entry => (
                <div
                  key={entry.path}
                  className={`file-row ${gridClass} ${
                    selected.has(entry.path)
                      ? "is-selected"
                      : ""
                  }`}
                  // 落点判定只读这两个属性：路径用于配对，isDir 决定
                  // "落进这个目录"还是"落到所在目录"。刻意不把整条
                  // listing 塞进属性里 —— 大目录下那会撑爆 DOM。
                  data-entry-path={entry.path}
                  data-entry-dir={entry.isDir}
                  data-dragging={
                    isDragging?.(entry.path) ||
                    undefined
                  }
                  data-drop-target={
                    isTarget?.(entry.path) ||
                    undefined
                  }
                  onPointerDown={event => {
                    selectOnPointerDown(
                      entry,
                      event
                    );
                    onDragStart(
                      side,
                      dragEntries(entry),
                      event
                    );
                  }}
                  onDoubleClick={() => {
                    if (entry.isDir)
                      onOpen(entry.path);
                  }}
                  onContextMenu={event => {
                    // 行上右键：菜单针对这个条目；阻止冒泡避免被当成空白处。
                    // 点中的行不在选中里时，选中整体换成它（资源管理器语义）
                    event.preventDefault();
                    event.stopPropagation();
                    const inSelection =
                      selected.has(entry.path);
                    if (!inSelection) {
                      setSelected(
                        new Set([entry.path])
                      );
                      setAnchor(entry.path);
                    }
                    setMenu({
                      x: event.clientX,
                      y: event.clientY,
                      entry,
                      count: inSelection
                        ? Math.max(
                            1,
                            selected.size
                          )
                        : 1
                    });
                  }}
                >
                  <span className="cell-name">
                    <EntryIcon
                      entry={entry}
                      icons={listing?.icons}
                    />
                    <span className="file-name">
                      {entry.name}
                    </span>
                  </span>
                  <span className="cell-size">
                    {entry.isDir
                      ? ""
                      : formatSize(entry.size)}
                  </span>
                  {!isLocal && (
                    <span className="cell-perm">
                      {formatPerm(entry)}
                    </span>
                  )}
                  {!isLocal && (
                    <span className="cell-owner">
                      {entry.owner ?? "—"}
                    </span>
                  )}
                  <span className="cell-time">
                    {formatTime(entry.modified)}
                  </span>
                </div>
              ))
            ) : (
              <EmptyState className="pane-empty">
                {keyword
                  ? `无匹配「${filter.trim()}」`
                  : busy
                    ? "加载中…"
                    : emptyText}
              </EmptyState>
            )}
          </>
        )}
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          count={menu.count}
          isLocal={isLocal}
          canPaste={canPaste}
          onAction={action => {
            // "新建"要先弹窗收集类型与名称，交给对话框去执行
            if (action === "create") {
              setCreating(true);
              return;
            }
            // 删除是不可逆操作，先弹二次确认（多选时确认整批）
            if (action === "delete") {
              if (menuEntries.length)
                setPendingDelete(menuEntries);
              return;
            }
            // 重命名要先收集新名称，交给对话框去执行（仅单选可用）
            if (action === "rename") {
              if (menu.entry)
                setRenameTarget(menu.entry);
              return;
            }
            // 权限修改要先拿到当前权限位，交给对话框去编辑（多选整批）
            if (action === "chmod") {
              if (menuEntries.length)
                setChmodTarget(menuEntries);
              return;
            }
            // 批量传输派发后清掉选中，行上的高亮别留着误导
            if (
              action === "transfer" &&
              menuEntries.length > 1
            ) {
              clearSelection();
            }
            onContextAction(
              action,
              menu.entry,
              menuEntries
            );
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {creating && (
        <NewEntryDialog
          onCreate={onCreate}
          onClose={() => setCreating(false)}
        />
      )}
      {renameTarget && (
        <RenameDialog
          name={renameTarget.name}
          onConfirm={name =>
            onRename(renameTarget, name)
          }
          onClose={() => setRenameTarget(null)}
        />
      )}
      {chmodTarget && (
        <ChmodDialog
          name={
            chmodTarget.length > 1
              ? `${chmodTarget[0]!.name} 等 ${chmodTarget.length} 项`
              : chmodTarget[0]!.name
          }
          // 取不到权限位时按 644 兜底（远程一般都能拿到）
          current={chmodTarget[0]!.perm ?? 0o644}
          onConfirm={mode => {
            onChmod?.(chmodTarget, mode);
            clearSelection();
          }}
          onClose={() => setChmodTarget(null)}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          eyebrow="删除"
          title={
            pendingDelete.length > 1
              ? `确定删除这 ${pendingDelete.length} 项？`
              : `确定删除${
                  pendingDelete[0]!.isDir
                    ? "文件夹"
                    : "文件"
                }「${pendingDelete[0]!.name}」？`
          }
          description={
            pendingDelete.some(
              entry => entry.isDir
            )
              ? "文件夹及其中的全部内容都会被删除，此操作不可撤销。"
              : "此操作不可撤销。"
          }
          confirmText="删除"
          danger
          onConfirm={() => {
            onContextAction(
              "delete",
              pendingDelete[0]!,
              pendingDelete
            );
            clearSelection();
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </Surface>
  );
});

export default FilePane;
