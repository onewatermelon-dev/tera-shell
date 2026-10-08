/**
 * SFTP 双栏拖拽的落点判定（纯函数，无 DOM 依赖）。
 *
 * 为什么单独成文件：拖拽的表现问题（拖不动、落点判错）在真机上手工验证
 * 成本极高，而本项目有过一次教训 —— HTML5 原生拖放在 WebView2 里**整段
 * 静默失效**。所以判定规则必须能被单测钉死。
 *
 * ⚠️ 本文件**不能引用 window / document / Element**：测试跑在
 * `environment: "node"` 下，这些全局不存在（`instanceof Element` 直接
 * ReferenceError）。
 */
import type {
  PaneEntry,
  PaneSide
} from "@/sftp/lib/useSftp";

/**
 * 一次拖拽的落点。
 *
 * - `pane`：落在哪一栏。跨栏拖拽才需要它，同栏拖拽恒为来源栏。
 * - `entryPath`：命中的条目路径；落在空白处为 null。
 * - `intoDirectory`：最终应该落地的**目录**路径 —— 命中目录条目时是该目录
 *   本身，命中文件条目 / 空白处时是所在栏的当前目录。
 *
 * 把「命中谁」与「落到哪」分开，是为了调用方不必再判断 isDir：判定规则
 * 里对目录的特判集中在这里，调用方只管用结果拼路径。
 */
export type DropTarget = {
  pane: PaneSide;
  entryPath: string | null;
  intoDirectory: string;
};

/** 判定所需的最小信息（与真实列表解耦，便于造样本）。 */
export type DropProbe = {
  /** 来源栏。**同栏拖拽一律拒绝**（复制靠右键菜单的复制/粘贴）。 */
  from: PaneSide;
  /** 指针落在哪一栏（调用方用 elementFromPoint 找最近的栏容器得到）。 */
  pane: PaneSide;
  /** 命中的条目；空白处为 null */
  entry: PaneEntry | null;
  /** 所在栏的当前目录路径 */
  panePath: string;
};

/**
 * 判定一次拖拽的落点，返回 null 表示「不接受这次落点」。
 *
 * 规则：
 * ① **同栏不接收** —— 栏内挪动不是传输，跨栏才是。返回 null 让调用方
 *    把高亮撤掉。
 * ② 落在**目录条目**上 → 进那个目录（最常用：拖到文件夹里）。
 * ③ 落在**文件条目**上 → 落到所在栏当前目录（不覆盖同名文件）。
 * ④ 落在**空白处** → 落到所在栏当前目录。
 *
 * ⚠️ ③ 与 ④ 产出同一个目录是有意的：拖到文件条目上时若进它的父目录，
 * 用户会以为「文件被替换了」。落到当前目录、名字冲突由后端的写入行为
 * 决定，语义更清楚。
 */
export function resolveDropTarget(
  probe: DropProbe
): DropTarget | null {
  // ① 同栏：不是传输
  if (probe.from === probe.pane) return null;
  // 所在栏还没加载出目录，没法作为落点
  if (!probe.panePath) return null;
  // ② 目录条目：落进它
  if (probe.entry?.isDir) {
    return {
      pane: probe.pane,
      entryPath: probe.entry.path,
      intoDirectory: probe.entry.path
    };
  }
  // ③④ 文件条目 / 空白：落到所在栏当前目录
  return {
    pane: probe.pane,
    entryPath: probe.entry?.path ?? null,
    intoDirectory: probe.panePath
  };
}

/**
 * 一次拖拽带来的条目列表（可能多项：整目录拖、或将来支持多选）。
 *
 * ⚠️ `entries` 可能为空数组（拖到空处），调用方要能挡一下。
 */
export type DragPayload = {
  from: PaneSide;
  entries: PaneEntry[];
};
