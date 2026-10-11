import { invoke } from "@tauri-apps/api/core";

/** 两栏的标识：本地 / 远程。 */
export type PaneSide = "local" | "remote";

/** 传输任务状态。 */
export type TransferStatus =
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

/** 传输任务方向：上传 / 下载 / 远程删除。 */
export type TransferDirection =
  "upload" | "download" | "delete";

/** 传输任务的控制动作。 */
export type TransferControlAction =
  "pause" | "resume" | "cancel";

/** 远程磁盘用量（SFTP 状态条展示用）。 */
export type RemoteDiskUsage = {
  /** 落点所在文件系统的总容量 */
  totalBytes: number;
  /** 可用空间 */
  freeBytes: number;
  /** 当前目录累计大小；du 失败时为 0 */
  dirBytes: number;
};

/**
 * 同名落点冲突策略。
 *
 * overwrite 截断重写（旧行为）；skip 跳过已存在的；
 * rename 换 `a (1).txt` 相邻路径；resume 从目标已有字节数处接续。
 */
export type TransferPolicy =
  "overwrite" | "skip" | "rename" | "resume";

/**
 * 找出与目标目录同名的顶层条目（要传的内容 vs 目标栏当前列表）。
 *
 * 只按名字判断，类型不一致（源是文件、目标同名是目录）也算冲突 ——
 * 后端遇到这种落点必然报错，提前拦在对话框里。
 */
export function findCollisions(
  entries: PaneEntry[],
  targetListing: PaneEntry[]
): PaneEntry[] {
  if (!entries.length || !targetListing.length) {
    return [];
  }
  const names = new Set(
    targetListing.map(entry => entry.name)
  );
  return entries.filter(entry =>
    names.has(entry.name)
  );
}

/**
 * 冲突里是否存在可续传项：目标同名**文件**比源小。
 *
 * 只有这种情况"续传"按钮才有意义 —— 目标更大说明内容对不上，
 * 目标是目录则没有"续传"概念。
 */
export function hasResumable(
  collisions: PaneEntry[],
  targetListing: PaneEntry[]
): boolean {
  const sizes = new Map(
    targetListing.map(entry => [
      entry.name,
      entry
    ])
  );
  return collisions.some(entry => {
    const target = sizes.get(entry.name);
    return (
      !!target &&
      !target.isDir &&
      !entry.isDir &&
      target.size < entry.size
    );
  });
}

/** 目录条目：本地 `fs_list_dir` 与远程 `sftp_list` 返回同构数据。 */
export type PaneEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** 修改时间（Unix 秒）；取不到时为 null */
  modified?: number | null;
  /** Unix 权限位（含文件类型位）；Windows 本地文件为 null */
  perm?: number | null;
  /** 所有者名称；Windows 本地文件为 null */
  owner?: string | null;
  /** 所属组名称；Windows 本地文件为 null */
  group?: string | null;
  /** 图标键：`dir` 或小写扩展名，用于在同一份 `icons` 表里查系统图标 */
  iconKey?: string;
};

/** 目录浏览结果（本地 / 远程通用）。 */
export type PaneListing = {
  path: string;
  parent?: string | null;
  entries: PaneEntry[];
  /** 本次列表用到的系统图标：键（iconKey）→ PNG data URL，同类型只带一张 */
  icons?: Record<string, string>;
};

/** 一次传输任务（进度由后端的 `sftp-transfer` 事件推送）。 */
export type TransferTask = {
  id: string;
  name: string;
  direction: TransferDirection;
  status: TransferStatus;
  /** 已传输字节数 */
  bytes: number;
  /** 总字节数；取不到时为 0，此时不显示百分比 */
  total: number;
  /** 开始时间（毫秒时间戳） */
  startedAt: number;
  /** 结束时间（毫秒时间戳） */
  endedAt?: number;
  /** 暂停时刻（毫秒时间戳）；恢复时清空并折算进 pausedMs */
  pausedAt?: number;
  /** 累计暂停时长（毫秒）：经过时间与速度都要扣除它 */
  pausedMs?: number;
  /** 失败原因 */
  error?: string;
};

/** 后端进度事件的负载。 */
export type TransferEvent = {
  id: string;
  bytes: number;
  total: number;
  done: boolean;
};

/** 任务面板最多保留的记录条数，超出丢弃最早的。 */
export const TRANSFER_LIMIT = 50;

/**
 * 把一条后端进度事件并进任务状态，返回新任务对象。
 *
 * 两条规则：
 * - 暂停是用户手势：暂停生效前发出的进度事件仍在途中，到达时不能把
 *   刚点下的暂停冲回"传输中"——否则按钮弹回"暂停"、看起来要点两次
 *   才真的停。
 * - 终态（完成/失败/已取消）不被迟到事件复活：取消后残留的进度事件
 *   若把行翻回"传输中"，再点取消会因后端任务已注销而报错，行就
 *   永远卡死在"传输中"。
 */
export function applyTransferEvent(
  task: TransferTask,
  event: TransferEvent
): TransferTask {
  const terminal =
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "cancelled";
  return {
    ...task,
    bytes: event.bytes,
    // 事件里的总量可能比列表里更准，非 0 时覆盖
    total: event.total || task.total,
    status: terminal
      ? task.status
      : event.done
        ? "done"
        : task.status === "paused"
          ? "paused"
          : "running",
    endedAt: event.done
      ? (task.endedAt ?? Date.now())
      : task.endedAt
  };
}

/**
 * 任务的"活跃"经过时长（毫秒）：扣除累计暂停时间。
 *
 * 暂停中定格在暂停时刻（不再随 now 增长），运行中随 now 走，
 * 结束后用 endedAt 收口——速度用它做分母，暂停时也会跟着定格。
 */
export function activeElapsedMs(
  task: TransferTask,
  now: number
): number {
  return Math.max(
    0,
    (task.endedAt ?? task.pausedAt ?? now) -
      task.startedAt -
      (task.pausedMs ?? 0)
  );
}

/**
 * 计算文件行被点击（主键）后的新选中集合。
 *
 * 与资源管理器一致：普通点击只选它；Ctrl 切换它；Shift 从锚点
 * 扫到它（替换整个选中）。Shift 但没有锚点时退化为普通点击。
 * `paths` 是当前列表的完整路径顺序，范围选择靠下标。
 */
export function nextSelection(
  current: Set<string>,
  paths: string[],
  target: string,
  options: {
    ctrl?: boolean;
    shift?: boolean;
    anchor?: string | null;
  }
): Set<string> {
  const anchor = options.anchor ?? null;
  if (options.shift && anchor) {
    const from = paths.indexOf(anchor);
    const to = paths.indexOf(target);
    if (from !== -1 && to !== -1) {
      const [start, end] =
        from < to ? [from, to] : [to, from];
      return new Set(paths.slice(start, end + 1));
    }
  }
  if (options.ctrl) {
    const next = new Set(current);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return next;
  }
  return new Set([target]);
}

/**
 * 把选中路径集映射回当前列表的条目：顺序跟随列表，
 * 自动过滤掉已不存在的路径（导航 / 刷新后的残留选中）。
 */
export function resolveSelected<
  T extends { path: string }
>(entries: T[], selected: Set<string>): T[] {
  if (selected.size === 0) return [];
  return entries.filter(entry =>
    selected.has(entry.path)
  );
}

/**
 * 生成传输任务 id：前后端共用，进度事件靠它找到面板里的那一行。
 */
export function newTransferId(): string {
  return `t-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * 判断会话里存的密码是否像 DPAPI 密文（标准 base64）。
 *
 * DPAPI 密文经 base64 后一定很长（短密码也在 100 字符以上），因此用「长度 +
 * 字符集」双重判断：早期版本的会话可能直接明文存密码，明文常含 `~`、空格等
 * 非 base64 字符，送去 base64 解码会报 "Invalid symbol ..."。长度阈值也能
 * 排除纯字母数字的明文密码。
 */
function looksEncrypted(value: string): boolean {
  return (
    value.length >= 44 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

/**
 * 把会话里存的密码还原成明文：像密文才送去解密，否则按明文使用
 * （兼容早期直接存明文的历史数据）。
 */
export async function resolvePassword(
  stored: string
): Promise<string> {
  if (!looksEncrypted(stored)) return stored;
  try {
    return await invoke<string>("decrypt", {
      encoded: stored
    });
  } catch {
    // 解不出来时退回原值，交给认证环节给出更准确的提示
    return stored;
  }
}

/**
 * 拼接目录与名称，自动沿用该侧的路径分隔符
 * （本地 Windows 用 `\`，远程 Unix 用 `/`）。
 */
export function joinPath(
  directory: string,
  name: string
): string {
  const separator = directory.includes("\\")
    ? "\\"
    : "/";
  const base = directory.replace(/[\\/]+$/, "");
  return `${base}${separator}${name}`;
}

/** 从完整路径里取出文件/目录名。 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
