/**
 * 单栏文件列表的导航与选中状态。
 *
 * 从 FilePane.tsx 拆出（2026-10-13）。四件事天生该在一起：
 * 导航历史（后退/前进）、多选选中集、目录内过滤，以及**换目录时
 * 的一次性重置** —— 后者是同一个渲染期条件里的同一个动作，拆开到
 * 两个 hook 各存一份「上次路径」只会互相漂移。
 */
import { useState } from "react";
import type { PaneEntry } from "@/sftp/lib/useSftp";
import {
  nextSelection,
  resolveSelected
} from "@/sftp/lib/sftpUtils";

export function useFilePaneState(
  /** 当前目录（父级加载成功后传入；undefined = 还没连上） */
  listingPath: string | undefined,
  /** 完整条目列表（选中集按它解析，自动滤掉已消失的路径） */
  entries: PaneEntry[],
  onOpen: (path: string) => void
) {
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
  if (listingPath && listingPath !== recorded) {
    setRecorded(listingPath);
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
      if (kept[kept.length - 1] === listingPath) {
        return previous;
      }
      kept.push(listingPath);
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

  /** 行主键按下后的选中集合变化（普通 / Ctrl / Shift 三种语义）。 */
  function selectOnPointerDown(
    entry: PaneEntry,
    event: React.PointerEvent
  ) {
    if (event.button !== 0) return;
    const paths = entries.map(e => e.path);
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
      entries,
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

  return {
    trail,
    go,
    selected,
    setSelected,
    setAnchor,
    filter,
    setFilter,
    selectOnPointerDown,
    dragEntries,
    clearSelection
  };
}
