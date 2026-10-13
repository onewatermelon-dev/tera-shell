import {
  useCallback,
  useEffect,
  useState
} from "react";
import {
  CaretRightFilled,
  FolderOutlined
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import type { PaneListing } from "@/sftp/lib/useSftp";

/** 路径选择器里的一个入口节点（后端 `fs_places` / `fs_drives` 返回）。 */
export type PlaceNode = {
  name: string;
  path: string;
  /** `dir` 普通目录（可展开）；`place` 固定入口（桌面/音乐等，点了就选中）；
   *  `computer` 表示"此电脑"，展开后列出盘符 */
  kind: string;
  /** 图标键，用于在 icons 表里查系统图标；无图标为空串 */
  iconKey?: string;
};

/** 后端 `fs_places` / `fs_drives` 的返回：入口 + 对应系统图标。 */
export type PlaceListing = {
  places: PlaceNode[];
  icons: Record<string, string>;
};

type PathPickerProps = {
  /** 根入口列表（父级在打开选择器时加载好传入，避免本组件用 effect 拉数据）。 */
  places: PlaceNode[];
  /** 根入口的系统图标（键 → PNG data URL）。 */
  icons: Record<string, string>;
  /** 选中某个路径（本地栏随之导航到该目录）。 */
  onSelect: (path: string) => void;
  /** 关闭选择面板。 */
  onClose: () => void;
};

/**
 * 本地路径选择面板：桌面/文档/下载等固定入口 + "此电脑"逐级展开浏览。
 *
 * 交互约定：
 *   · 点击行首箭头 —— 展开 / 收起子目录（"此电脑"只展开盘符）；
 *   · 点击行文字   —— 选中该路径并触发 onSelect；
 *   · "此电脑"自身没有路径，点击它等于展开。
 *
 * 图标全部来自后端取回的 Windows 系统图标，取不到的节点才回退线性图标。
 */
export default function PathPicker({
  places,
  icons,
  onSelect,
  onClose
}: PathPickerProps) {
  // 已展开节点的子列表，按 key（普通目录用路径，"此电脑"用固定键）索引
  const [children, setChildren] = useState<
    Record<string, PlaceNode[]>
  >({});
  const [loading, setLoading] = useState<
    Record<string, boolean>
  >({});
  // 展开子目录时新拿到的图标，与根入口的图标合并使用
  const [extraIcons, setExtraIcons] = useState<
    Record<string, string>
  >({});
  const allIcons = { ...icons, ...extraIcons };

  const nodeKey = (node: PlaceNode) =>
    node.kind === "computer"
      ? "computer"
      : node.path;

  const toggle = useCallback(
    async (node: PlaceNode) => {
      const key = nodeKey(node);
      if (children[key]) {
        // 已展开：收起
        setChildren(previous => {
          const next = { ...previous };
          delete next[key];
          return next;
        });
        return;
      }
      if (loading[key]) return;
      setLoading(previous => ({
        ...previous,
        [key]: true
      }));
      try {
        let list: PlaceNode[];
        if (node.kind === "computer") {
          // 此电脑：只列盘符
          const listing =
            await invoke<PlaceListing>(
              "fs_drives"
            );
          list = listing.places;
          setExtraIcons(previous => ({
            ...previous,
            ...listing.icons
          }));
        } else {
          const listing =
            await invoke<PaneListing>(
              "fs_list_dir",
              { path: node.path }
            );
          list = listing.entries
            .filter(entry => entry.isDir)
            .map(entry => ({
              name: entry.name,
              path: entry.path,
              kind: "dir",
              iconKey: entry.iconKey
            }));
          if (listing.icons) {
            setExtraIcons(previous => ({
              ...previous,
              ...listing.icons
            }));
          }
        }
        setChildren(previous => ({
          ...previous,
          [key]: list
        }));
      } catch {
        // 目录可能读不到（无权限等），展示为空分支，不影响其余节点
        setChildren(previous => ({
          ...previous,
          [key]: []
        }));
      } finally {
        setLoading(previous => {
          const next = { ...previous };
          delete next[key];
          return next;
        });
      }
    },
    [children, loading]
  );

  // 点击面板与触发按钮之外的区域时收起
  useEffect(() => {
    const handlePointerDown = (
      event: MouseEvent
    ) => {
      const target = event.target as HTMLElement;
      if (
        !target.closest(".path-picker") &&
        !target.closest(".path-pick-button")
      ) {
        onClose();
      }
    };
    document.addEventListener(
      "mousedown",
      handlePointerDown
    );
    return () =>
      document.removeEventListener(
        "mousedown",
        handlePointerDown
      );
  }, [onClose]);

  /** 行图标：优先系统图标，取不到回退线性文件夹图标。 */
  function NodeIcon({
    node
  }: {
    node: PlaceNode;
  }) {
    const source = node.iconKey
      ? allIcons[node.iconKey]
      : undefined;
    if (source)
      return (
        <img
          className="picker-icon"
          src={source}
          alt=""
        />
      );
    return <FolderOutlined />;
  }

  const renderRows = (
    nodes: PlaceNode[],
    depth: number
  ) =>
    nodes.map(node => {
      const key = nodeKey(node);
      const isExpanded = Boolean(children[key]);
      // 只有普通目录与"此电脑"可以展开；固定入口不行
      const canExpand = node.kind !== "place";
      return (
        <div key={key || node.name}>
          <div
            className="picker-row"
            style={{
              paddingLeft: 8 + depth * 14
            }}
          >
            {/* 固定入口（桌面/音乐/视频等）是快捷方式，不提供逐级展开 */}
            {canExpand ? (
              <button
                type="button"
                className="picker-toggle"
                aria-label={
                  isExpanded ? "收起" : "展开"
                }
                onClick={() => void toggle(node)}
              >
                <CaretRightFilled
                  className={
                    isExpanded
                      ? "picker-caret expanded"
                      : "picker-caret"
                  }
                />
              </button>
            ) : (
              <span className="picker-spacer" />
            )}
            <button
              type="button"
              className="picker-label"
              onClick={() => {
                if (node.path)
                  onSelect(node.path);
                else void toggle(node);
              }}
            >
              <NodeIcon node={node} />
              <span>{node.name}</span>
            </button>
          </div>
          {loading[key] && (
            <div
              className="picker-hint"
              style={{
                paddingLeft: 30 + depth * 14
              }}
            >
              加载中…
            </div>
          )}
          {children[key] &&
            renderRows(children[key], depth + 1)}
        </div>
      );
    });

  return (
    <div className="path-picker">
      {renderRows(places, 0)}
    </div>
  );
}
