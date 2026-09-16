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
