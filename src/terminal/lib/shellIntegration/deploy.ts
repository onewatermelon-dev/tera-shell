/**
 * 远端 shell 集成的部署：探测 shell → 写钩子 → 幂等地挂到 rc。
 *
 * ## 为什么要赶在 PTY 启动之前
 *
 * ssh 登录时远端 shell 会**立刻**读 rc 文件。如果等连上之后再部署，
 * 本次会话的 shell 已经跑起来了，钩子只能等下次连接才生效 —— 用户会
 * 觉得「装了但没效果」。所以部署必须发生在 `terminal_start` 之前：
 * 那时还没有任何 shell 进程，rc 一改，本次登录就带着钩子上路。
 *
 * 代价是首次连接多一次 ssh2 往返（约 0.5–1.5 秒）。用三条约束压住：
 *
 * 1. **缓存**：按 `user@host:port` 记版本号，装过就直接跳过（0 成本）。
 * 2. **超时**：整体 4 秒封顶，超时/失败都不阻塞建连（本次退回启发式）。
 * 3. **失败冷却**：失败后 10 分钟内不再重试，避免每次开会话都白等。
 *
 * ## 与终端 PTY 的关系
 *
 * 这里走的是 `ssh2` exec 通道（独立连接），不经过终端 PTY —— 因此部署
 * 输出不会污染用户屏幕，也不进远端命令历史。
 */
import type { SshTarget } from "@/sessions/lib/sshTarget";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import { aiRunCommand } from "@/terminal/lib/ai/aiExec";
import { shellIntegrationDisabled } from "./shellIntegration";
import {
  buildInstallCommand,
  DETECT_SHELL_COMMAND,
  HOOK_VERSION,
  type RemoteShell
} from "./hooks";

/** 整体部署超时：超过就不等了，本次连接按「无集成」处理。 */
const DEPLOY_TIMEOUT_MS = 4000;

/** 失败冷却：这段时间内同一目标不再尝试，免得每次开会话都白等。 */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

/** 一条部署记录。 */
type CacheEntry = {
  /** 已安装的钩子版本；0 表示上次失败 */
  version: number;
  /** 上次尝试时间（毫秒时间戳） */
  at: number;
};

/** 缓存表：`user@host:port` → 记录。 */
type DeployCache = Record<string, CacheEntry>;

/** 读取缓存；损坏时按空表处理（部署一次就能重建）。 */
function readCache(): DeployCache {
  try {
    const raw = readData(
      DataName.shellIntegration
    );
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return {};
    return parsed as DeployCache;
  } catch (reason) {
    console.warn(
      "[shell-integration] 部署缓存读取失败",
      reason
    );
    return {};
  }
}

/** 写回缓存（内存先行，落盘异步）。 */
function writeCache(cache: DeployCache): void {
  writeData(
    DataName.shellIntegration,
    JSON.stringify(cache)
  );
}

/** 缓存键：同一台机器的不同用户各自算一份（rc 在各自 home 下）。 */
function cacheKey(target: SshTarget): string {
  return `${target.username}@${target.host}:${target.port}`;
}

/**
 * 给 promise 套一个超时：超时返回 `fallback`，但不取消原操作
 * （后端的 exec 通道会自己超时退出）。
 *
 * @param promise 目标异步操作
 * @param ms 超时毫秒
 * @param fallback 超时返回值
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(
        `[shell-integration] 部署超时（${ms}ms），本次按无集成处理`
      );
      resolve(fallback);
    }, ms);
    promise
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(reason => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.warn(
          "[shell-integration] 部署失败",
          reason
        );
        resolve(fallback);
      });
  });
}

/**
 * 探测远端登录 shell。认不出来（`none`/未知）就当不支持。
 *
 * @param target 连接目标
 */
async function detectShell(
  target: SshTarget
): Promise<RemoteShell | null> {
  const result = await aiRunCommand(
    target,
    DETECT_SHELL_COMMAND
  );
  if (result.exitCode !== 0) {
    console.warn(
      "[shell-integration] 探测 shell 失败",
      result.exitCode,
      result.stderr
    );
    return null;
  }
  const name = result.stdout.trim();
  if (
    name === "bash" ||
    name === "zsh" ||
    name === "pwsh"
  )
    return name;
  console.info(
    `[shell-integration] 远端 shell 不支持：${name || "(空)"}`
  );
  return null;
}

/**
 * 确保这台主机装好了 shell 集成。
 *
 * 命中缓存（版本相同）立即返回 true，不产生任何网络往返。
 *
 * @param target 连接目标（含明文密码或私钥路径）
 * @returns 本次连接是否**已经**具备钩子（含此前装好的）
 */
export async function ensureShellIntegration(
  target: SshTarget
): Promise<boolean> {
  // 应急开关：连远端都不要动（避免还在往用户 rc 里写东西）
  if (shellIntegrationDisabled()) return false;
  const key = cacheKey(target);
  const cache = readCache();
  const entry = cache[key];
  const now = Date.now();
  if (entry) {
    if (entry.version >= HOOK_VERSION)
      return true;
    if (
      entry.version === 0 &&
      now - entry.at < FAILURE_COOLDOWN_MS
    ) {
      console.debug(
        "[shell-integration] 上次部署失败，冷却中，跳过"
      );
      return false;
    }
  }
  const installed = await withTimeout(
    deploy(target),
    DEPLOY_TIMEOUT_MS,
    false
  );
  const next = readCache();
  next[key] = {
    version: installed ? HOOK_VERSION : 0,
    at: now
  };
  writeCache(next);
  return installed;
}

/**
 * 真正的部署：探测 + 安装。成功返回 true。
 *
 * @param target 连接目标
 */
async function deploy(
  target: SshTarget
): Promise<boolean> {
  const shell = await detectShell(target);
  if (!shell) return false;
  const result = await aiRunCommand(
    target,
    buildInstallCommand(shell)
  );
  if (result.exitCode !== 0) {
    console.warn(
      "[shell-integration] 写入钩子失败",
      shell,
      result.exitCode,
      result.stderr.slice(0, 400)
    );
    return false;
  }
  console.info(
    `[shell-integration] 已为 ${cacheKey(target)} 部署 ${shell} 钩子（v${HOOK_VERSION}）`
  );
  return true;
}
