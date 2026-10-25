/**
 * 把一份存档「演」回运行态：按顺序打开会话，再重建窗格与布局树。
 *
 * 抽成独立函数（而不是塞进 useTerminals）有两个原因：
 * 1. 顺序与回落规则值得单测 —— 哪个会话能开、哪一格该显示谁、空窗格
 *    怎么折叠，全是容易写错又不会报错的地方；
 * 2. 依赖全部以参数注入，测试里不需要 React 也不需要真实 PTY。
 *
 * ## 几个刻意的取舍
 *
 * - **串行打开**：一次并发 N 个 SSH 连接会同时触发 N 次认证与握手，
 *   密码类会话还会互相抢同一个密码弹窗。串行的代价只是启动多几百毫秒，
 *   而启动画面本来就要转 5 秒。
 * - **打不开就跳过，不阻塞**：需要密码的会话 `openOne` 返回 `password`
 *   （密码框由上层照常弹一次），这里继续下一个 —— 否则一个密码框没填，
 *   后面的标签全都不还原。
 * - **同一来源可以有多只**：用户「拆分窗格」「复制标签」都会为同一个来源
 *   再开一只实例，它们各有各的 PTY。存档用 `copy` 标记区分，还原时副本
 *   要**新开一只**（见 SavedTab 的注释）—— 早先按来源去重，把第二只当成
 *   重复丢掉，分屏就还原不出来了（2026-10-25 实测：存档里有分屏，还原后
 *   变回单窗格）。
 */

import {
  removePane,
  type PaneNode
} from "@/terminal/lib/pane/paneLayout";
import type { PaneState } from "@/terminal/lib/session/paneGrid";
import type { SavedSession } from "@/sessions/lib/session";
import type {
  SavedLayout,
  SavedTab
} from "@/terminal/lib/session/terminalLayout";
import type { OpenOutcome } from "@/terminal/lib/session/useTerminalSessions";

/** 还原结果（给启动日志与「都没有还原成功」的回落判断用）。 */
export type RestoreResult = {
  /** 成功打开的会话数 */
  restored: number;
  /** 跳过的来源 id（会话已删除 / 需要密码 / 启动失败） */
  skipped: string[];
};

/** 按树的视觉顺序列出全部标签（先 first 后 second）。 */
export function sourceOrder(
  saved: SavedLayout
): SavedTab[] {
  const byId = new Map(
    saved.panes.map(pane => [pane.id, pane])
  );
  const out: SavedTab[] = [];
  for (const paneId of collectLeaves(saved.tree))
    out.push(...(byId.get(paneId)?.tabs ?? []));
  return out;
}

/** 深度优先取叶子 id（避免再从 paneLayout 导一次）。 */
function collectLeaves(node: PaneNode): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return [
    ...collectLeaves(node.first),
    ...collectLeaves(node.second)
  ];
}

/**
 * 执行还原。
 *
 * @param input.findSession 按来源 id 找会话（找不到 = 会话被删了，跳过）
 * @param input.openOne 打开一只会话；返回「已打开 / 要密码 / 失败」
 * @param input.makeCopyName 给副本实例起名（避免与已打开的标签重名）
 * @param input.apply 把重建好的窗格、树、活动窗格一次性写回运行态
 */
export async function applyLayout(input: {
  saved: SavedLayout;
  findSession: (
    id: string
  ) => SavedSession | undefined;
  openOne: (
    session: SavedSession,
    /** 这只会话的来源 id（副本实例传**原会话**的 id） */
    originId: string
  ) => Promise<OpenOutcome>;
  makeCopyName: (source: SavedSession) => string;
  apply: (
    panes: PaneState[],
    tree: PaneNode,
    activePaneId: string
  ) => void;
}): Promise<RestoreResult> {
  const { saved } = input;
  const skipped: string[] = [];
  // 要密码的会话：密码请求是单份状态，后一只会覆盖前一只。
  // 这里先记下来，等循环跑完再对**第一只**重新发一次 —— 那时没有别的
  // 请求会来抢它，密码框就能稳稳地弹出来。
  const needPassword: SavedSession[] = [];
  const stamp = Date.now();
  let copyIndex = 0;
  /** 每格的结果：与存档里的标签同序，没打开的记空串 */
  const results: {
    paneId: string;
    runtimeIds: string[];
    visibleIndex: number;
  }[] = [];

  for (const paneId of collectLeaves(
    saved.tree
  )) {
    const pane = saved.panes.find(
      item => item.id === paneId
    );
    if (!pane) continue;
    const runtimeIds: string[] = [];
    for (const tab of pane.tabs) {
      const source = input.findSession(
        tab.source
      );
      if (!source) {
        // 会话被删了：静默跳过 —— 用户自己删的东西，不该弹错误
        skipped.push(tab.source);
        runtimeIds.push("");
        continue;
      }
      // 副本实例要新开一只：它有自己的 PTY，不能与原窗格共用
      const session: SavedSession = tab.copy
        ? {
            ...source,
            id: `dup-${source.id}-${stamp}-${copyIndex++}`,
            name: input.makeCopyName(source)
          }
        : source;
      // originId 传**来源**：副本实例的 sourceSessionId 必须指向原会话，
      // 否则下一轮存档里它的来源变成自己，下次还原就找不到人了
      const outcome = await input.openOne(
        session,
        source.id
      );
      if (outcome === "opened") {
        runtimeIds.push(session.id);
        continue;
      }
      skipped.push(tab.source);
      runtimeIds.push("");
      if (outcome === "password")
        needPassword.push(session);
    }
    results.push({
      paneId,
      runtimeIds,
      visibleIndex: pane.visible
    });
  }

  if (needPassword.length > 0) {
    // 重新触发第一只的密码请求（这次它就是最后一份，不会被覆盖）
    await input.openOne(
      needPassword[0]!,
      needPassword[0]!.id
    );
  }

  // 重建窗格：只留真正打开的标签
  const panes: PaneState[] = [];
  const removed: string[] = [];
  for (const item of results) {
    const tabIds =
      item.runtimeIds.filter(Boolean);
    if (tabIds.length === 0) {
      removed.push(item.paneId);
      continue;
    }
    // visible 记的是存档里的序号；要按同一序号取回运行时 id
    const visible =
      item.runtimeIds[item.visibleIndex] ||
      tabIds[0]!;
    panes.push({
      id: item.paneId,
      tabIds,
      visibleId: visible
    });
  }

  // 全都没还原成功：不动运行态，交给调用方回落到「开第一个会话」
  if (panes.length === 0)
    return { restored: 0, skipped };

  let tree = saved.tree;
  for (const paneId of removed)
    tree = removePane(tree, paneId);

  const activePaneId = panes.some(
    pane => pane.id === saved.activePaneId
  )
    ? saved.activePaneId
    : panes[0]!.id;
  input.apply(panes, tree, activePaneId);
  return {
    restored: panes.reduce(
      (sum, pane) => sum + pane.tabIds.length,
      0
    ),
    skipped
  };
}
