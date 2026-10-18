/**
 * 「发送到所有会话标签」的落点选择。
 *
 * 纯函数：菜单项拿到的是「已打开会话 + 断线表」，判断该往哪些标签
 * 下发命令是业务规则，值得单独测。放这里而不是 App.tsx —— App 里
 * 夹着 React 与 Tauri，规则没法单测。
 */

/** 参与选择的会话最小信息（不依赖 OpenSession 的运行时字段）。 */
export type BroadcastCandidate = {
  id: string;
  /** local = 本机终端，不该收到远程命令 */
  kind: "local" | "ssh";
};

export type BroadcastTargets = {
  /** 真正要下发的会话 id */
  ids: string[];
  /**
   * 被跳过的数量：断线的 + 本地会话。
   * 有值时要在反馈里说明 —— 用户以为「发到所有」就是全发了，
   * 少了几个却不说，他会以为是服务器没响应。
   */
  skipped: number;
};

/**
 * 选出要接收命令的会话 id。
 *
 * ## 口径：全部已打开的会话，不是每窗格可见的那只
 *
 * 与标签右键菜单的「关闭所有会话」同口径（`opened.map(s => s.id)`）。
 * 按 `panes[].visibleId` 只发窗格当前显示的那几只，会漏掉所有非活动
 * 标签 —— 而「所有标签」的意思显然包含它们。
 *
 * ## 为什么要先过滤断线
 *
 * `terminal_write` 对已关闭/已断开的会话返回「终端会话不存在」，
 * 而 App 的错误处理恰好**静默吞掉**这句（对用户毫无价值的旧会话错误）。
 * 不预先过滤的话，用户点了菜单看到零反馈，连哪几个失败了都无从判断。
 *
 * 本地会话同理：`run_command` 一类的宏命令对 Windows 本机终端没有意义，
 * 但仍要发（用户可能就写了 `dir`/`ipconfig`），所以只跳过不报错。
 *
 * @param opened 全部已打开的会话
 * @param disconnected 断线标记表（会话 id → 是否已断开）
 * @param activeId 当前活动会话 id：恒定包含，即便它已断线
 * @param includeLocal 是否给本地会话也发（默认给 —— 拦掉反而意外）
 */
export function broadcastTargets(
  opened: BroadcastCandidate[],
  disconnected: Record<string, boolean>,
  activeId?: string,
  includeLocal = true
): BroadcastTargets {
  const ids: string[] = [];
  let skipped = 0;
  for (const session of opened) {
    const isActive = session.id === activeId;
    if (
      !includeLocal &&
      session.kind === "local"
    ) {
      skipped += 1;
      continue;
    }
    // ⚠️ 活动会话即便断线也照发：它就是当前正看着的那只，
    // 静默跳过会让用户以为菜单坏了。失败由后端报错兜底
    if (
      disconnected[session.id] === true &&
      !isActive
    ) {
      skipped += 1;
      continue;
    }
    ids.push(session.id);
  }
  return { ids, skipped };
}
