import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import {
  type PaneEntry,
  type PaneListing,
  type RemoteDiskUsage
} from "@/sftp/lib/sftpUtils";
import { buildRemoteConnection } from "@/sftp/lib/sftpConnection";

/**
 * 两侧目录的浏览状态与导航动作。
 *
 * 本地目录走 `fs_list_dir`，远程目录走 `sftp_list`。首屏在打开动作用户点击时
 * 加载，之后的双击进入 / 上一级 / 右键菜单操作也都在事件回调里触发，
 * 所以组件内不需要用 effect 拉数据（首屏那一次除外，见文件末尾）。
 */
export function useSftpNavigation(
  session: SavedSession | null,
  /**
   * 首屏要定位到的目录（从目录栏点进来时带的就是终端当前目录）。
   * 空串 = 走默认目录（远程登录目录 / 本地主目录）。
   */
  initialPath = ""
) {
  const [local, setLocal] =
    useState<PaneListing | null>(null);
  const [localError, setLocalError] =
    useState("");
  const [remote, setRemote] =
    useState<PaneListing | null>(null);
  const [remoteError, setRemoteError] =
    useState("");
  const [remoteBusy, setRemoteBusy] =
    useState(false);
  // 同一时刻只允许一次远程导航：双击过快时后续请求会排在同一个连接锁上，
  // 表现为"点了半天才一个个响应"，这里直接忽略重复触发。
  const remoteBusyRef = useRef(false);
  // 远程磁盘用量：每次导航成功后异步刷新；ref 记录"已请求的目录"，
  // 结果回来时目录已切走就丢弃（响应乱序时不串台）
  const [remoteUsage, setRemoteUsage] =
    useState<RemoteDiskUsage | null>(null);
  const remoteUsagePathRef = useRef<
    string | null
  >(null);

  /** 浏览本地目录；不传路径表示用户主目录。 */
  const navigateLocal = useCallback(
    async (path?: string | null) => {
      setLocalError("");
      try {
        setLocal(
          await invoke<PaneListing>(
            "fs_list_dir",
            {
              path: path ?? null
            }
          )
        );
      } catch (reason) {
        setLocalError(String(reason));
        setLocal(null);
      }
    },
    []
  );

  /** 浏览远程目录；不传路径表示登录后的默认目录。 */
  const navigateRemote = useCallback(
    async (
      target: SavedSession,
      path?: string | null,
      /** 手动刷新：跳过后端目录缓存，强制重新读取。 */
      refresh = false
    ) => {
      // 上一次还没回来就忽略，避免请求在同一个连接上排队
      if (remoteBusyRef.current) return;
      remoteBusyRef.current = true;
      setRemoteError("");
      setRemoteBusy(true);
      try {
        // 跳板链 / 私钥 / 解密后的密码统一由 buildRemoteConnection 组装
        const connection =
          await buildRemoteConnection(target);
        const listing = await invoke<PaneListing>(
          "sftp_list",
          {
            request: {
              ...connection,
              path: path ?? null,
              refresh
            }
          }
        );
        setRemote(listing);
        // 磁盘用量异步跟上：不阻塞目录列表。df/du 走同一条 SSH
        // 会话的 exec 通道，超大目录的 du 会跑满会话超时后放弃
        remoteUsagePathRef.current = listing.path;
        void invoke<RemoteDiskUsage>(
          "sftp_disk_usage",
          {
            job: {
              ...connection,
              local: "",
              remote: listing.path
            }
          }
        )
          .then(usage => {
            if (
              remoteUsagePathRef.current ===
              listing.path
            )
              setRemoteUsage(usage);
          })
          .catch(() => {
            if (
              remoteUsagePathRef.current ===
              listing.path
            )
              setRemoteUsage(null);
          });
      } catch (reason) {
        // 失败时保留原目录内容（错误文案会盖在上面），不清空以便重试
        setRemoteError(String(reason));
      } finally {
        remoteBusyRef.current = false;
        setRemoteBusy(false);
      }
    },
    []
  );

  /**
   * 乐观改写远程当前目录的条目列表。
   *
   * 高延迟链路下一次 readdir 要 0.6~1.6s（日志实测），复制/挪动后
   * 等它对账体感很差：先按已知结果改本地列表立即呈现，随后台的
   * 强制刷新（refresh=true，会顺带更新后端目录缓存）再对账。
   */
  const patchRemoteEntries = useCallback(
    (
      update: (
        entries: PaneEntry[]
      ) => PaneEntry[]
    ) => {
      setRemote(previous =>
        previous
          ? {
              ...previous,
              entries: update(previous.entries)
            }
          : previous
      );
    },
    []
  );

  // 首屏：挂载（或换会话）时拉两侧目录。
  // 依赖都是稳定的 useCallback，因此只在会话变化时重新加载。
  useEffect(() => {
    if (!session) return;
    // 放进微任务：加载首屏会写状态，直接在 effect 体内调用会被
    // react-hooks/set-state-in-effect 判为级联渲染
    void Promise.resolve().then(() => {
      // 给了初始目录就跟过去：本地会话定位本地栏，SSH 定位远程栏
      void navigateLocal(
        session.kind === "local" && initialPath
          ? initialPath
          : undefined
      );
      // 本机终端没有远程目录，只有 SSH 会话才连 SFTP
      if (session.kind === "ssh")
        void navigateRemote(
          session,
          initialPath || undefined
        );
    });
  }, [
    session,
    initialPath,
    navigateLocal,
    navigateRemote
  ]);

  return {
    local,
    localError,
    remote,
    remoteError,
    remoteBusy,
    remoteUsage,
    navigateLocal,
    navigateRemote,
    patchRemoteEntries
  };
}
