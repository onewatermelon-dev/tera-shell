import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import {
  baseName,
  joinPath,
  resolvePassword,
  type PaneEntry,
  type PaneListing,
  type PaneSide,
  type TransferControlAction
} from "@/sftp/lib/sftpUtils";
import { useTransferTasks } from "@/sftp/lib/useTransferTasks";

// 类型定义集中在 sftpUtils，这里重新导出，外部仍从 useSftp 引入
export type {
  PaneEntry,
  PaneListing,
  PaneSide,
  TransferControlAction,
  TransferDirection,
  TransferStatus,
  TransferTask
} from "@/sftp/lib/sftpUtils";

/**
 * SFTP 窗口的数据源。
 *
 * 本地目录走 `fs_list_dir`，远程目录走 `sftp_list`。首屏在打开动作用户点击时
 * 加载，之后的双击进入 / 上一级 / 右键菜单操作也都在事件回调里触发，
 * 所以组件内不需要用 effect 拉数据。
 * 传输任务的登记与进度跟踪交给 `useTransferTasks`。
 */
export function useSftp(
  session: SavedSession | null = null
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
  // 复制 / 粘贴用的内部剪贴板（记来源栏与路径，粘贴时才真正执行）
  const [clipboard, setClipboard] = useState<{
    pane: PaneSide;
    path: string;
  } | null>(null);

  const tasks = useTransferTasks();

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
        // 密码解成明文过一次 IPC，后端只在内存里用，不写日志/落盘
        const password = target.password
          ? await resolvePassword(target.password)
          : undefined;
        setRemote(
          await invoke<PaneListing>("sftp_list", {
            request: {
              host: target.host,
              port: target.port,
              username: target.username,
              password,
              path: path ?? null,
              refresh
            }
          })
        );
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

  /** 组装远程操作需要的连接参数（含解密后的密码）。 */
  const remoteConnection =
    useCallback(async () => {
      if (!session) {
        throw new Error(
          "当前没有活动的 SFTP 会话"
        );
      }
      return {
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password
          ? await resolvePassword(
              session.password
            )
          : null
      };
    }, [session]);

  /**
   * 打开一个条目。
   *
   * 本地文件直接交给系统；远程文件本地程序够不着，先拉到临时目录再打开
   * （`sftp_edit_remote` 返回本地路径），之后本地一保存就自动回传远程。
   */
  const openEntry = useCallback(
    async (
      pane: PaneSide,
      entry: PaneEntry,
      withNotepad: boolean
    ) => {
      const target =
        pane === "remote"
          ? await invoke<string>(
              "sftp_edit_remote",
              {
                job: {
                  ...(await remoteConnection()),
                  local: "",
                  remote: entry.path
                }
              }
            )
          : entry.path;
      await invoke(
        withNotepad
          ? "fs_open_notepad"
          : "fs_open_path",
        { path: target }
      );
    },
    [remoteConnection]
  );

  /** 传输：本地文件上到远程当前目录，远程文件下到本地当前目录。 */
  const transferFile = useCallback(
    async (pane: PaneSide, entry: PaneEntry) => {
      const connection = await remoteConnection();
      const directory =
        pane === "local"
          ? remote?.path
          : local?.path;
      if (!directory) {
        throw new Error(
          pane === "local"
            ? "远程目录尚未加载，无法上传"
            : "本地目录尚未加载，无法下载"
        );
      }
      // 任务 id 前后端共用：先登记再调用，进度事件才有行可更新
      const id = tasks.registerTask(
        entry.name,
        pane === "local" ? "upload" : "download",
        entry.size
      );
      try {
        if (pane === "local") {
          await invoke("sftp_upload", {
            job: {
              ...connection,
              id,
              local: entry.path,
              remote: joinPath(
                directory,
                entry.name
              )
            }
          });
        } else {
          await invoke("sftp_download", {
            job: {
              ...connection,
              id,
              remote: entry.path,
              local: joinPath(
                directory,
                entry.name
              )
            }
          });
        }
      } catch (reason) {
        // 取消是用户主动行为，不算失败也不往上抛
        if (tasks.failTask(id, String(reason)))
          return;
        throw reason;
      }
      tasks.finishTask(id);
      // 目标目录刷新一次，新文件立刻可见
      if (pane === "local") {
        void navigateRemote(
          session as SavedSession,
          directory,
          true
        );
      } else {
        void navigateLocal(directory);
      }
    },
    [
      remoteConnection,
      remote?.path,
      local?.path,
      session,
      tasks,
      navigateRemote,
      navigateLocal
    ]
  );

  /**
   * 批量传输：把一批条目从来源栏传到目标栏的指定目录（拖拽用）。
   *
   * 与 `transferFile` 的区别有两个：
   * ① **目标目录显式传入** —— 拖拽可以落在子目录里，右键菜单的"传输"
   *    永远只传到另一栏的当前目录；
   * ② **不吞异常** —— 单个条目失败不该中断整批，逐个记 console 即可
   *    （传输面板里每条任务各自有成败状态）。
   *
   * ⚠️ `joinPath` 会沿用目录的分隔符：本地 Windows 是 `\`、远程是 `/`，
   * 传错目录会让拼接结果不对，所以这里不加工序，直接交给它判断。
   */
  const transferEntries = useCallback(
    async (
      from: PaneSide,
      entries: PaneEntry[],
      directory: string
    ) => {
      if (entries.length === 0) return;
      if (!directory) {
        throw new Error("目标目录尚未加载");
      }
      const connection = await remoteConnection();
      for (const entry of entries) {
        const id = tasks.registerTask(
          entry.name,
          from === "local"
            ? "upload"
            : "download",
          entry.size
        );
        try {
          if (from === "local") {
            await invoke("sftp_upload", {
              job: {
                ...connection,
                id,
                local: entry.path,
                remote: joinPath(
                  directory,
                  entry.name
                )
              }
            });
          } else {
            await invoke("sftp_download", {
              job: {
                ...connection,
                id,
                remote: entry.path,
                local: joinPath(
                  directory,
                  entry.name
                )
              }
            });
          }
        } catch (reason) {
          // 取消是用户主动行为，不算失败
          if (tasks.failTask(id, String(reason)))
            continue;
          console.error(
            `[sftp] 拖放传输失败：${entry.name}`,
            reason
          );
          continue;
        }
        tasks.finishTask(id);
      }
      // 目标栏刷新，新文件立刻可见。批量只刷一次，
      // 逐条刷会把远程栏的连接锁占满
      if (from === "local") {
        void navigateRemote(
          session as SavedSession,
          directory,
          true
        );
      } else {
        void navigateLocal(directory);
      }
    },
    [
      remoteConnection,
      tasks,
      navigateRemote,
      navigateLocal,
      session
    ]
  );

  /** 清空已结束的传输记录；正在传输的保留。 */
  const clearTransfers = tasks.clearTransfers;

  /** 暂停 / 恢复 / 取消某个传输任务。 */
  const controlTransfer = useCallback(
    async (
      id: string,
      action: TransferControlAction
    ) => {
      await tasks.controlTransfer(id, action);
    },
    [tasks]
  );

  /** 在当前目录下新建文件夹或空文件。 */
  const createEntry = useCallback(
    async (
      pane: PaneSide,
      isDir: boolean,
      name: string
    ) => {
      if (pane === "local") {
        const directory = local?.path;
        if (!directory) {
          throw new Error("本地目录尚未加载");
        }
        await invoke(
          isDir
            ? "fs_make_dir"
            : "fs_create_file",
          { path: joinPath(directory, name) }
        );
        void navigateLocal(directory);
        return;
      }
      const directory = remote?.path;
      if (!directory) {
        throw new Error("远程目录尚未加载");
      }
      const connection = await remoteConnection();
      await invoke(
        isDir
          ? "sftp_make_dir"
          : "sftp_create_file",
        {
          job: {
            ...connection,
            local: "",
            remote: joinPath(directory, name)
          }
        }
      );
      void navigateRemote(
        session as SavedSession,
        directory,
        true
      );
    },
    [
      remoteConnection,
      remote?.path,
      local?.path,
      session,
      navigateRemote,
      navigateLocal
    ]
  );

  /** 删除文件或目录（远程按递归删除，并在底部面板里显示进度）。 */
  const removeEntry = useCallback(
    async (pane: PaneSide, entry: PaneEntry) => {
      if (pane === "local") {
        await invoke("fs_remove_path", {
          path: entry.path
        });
        void navigateLocal(local?.path);
        return;
      }
      const connection = await remoteConnection();
      // 远程递归删除可能很慢，登记成一条任务走底部面板展示进度
      const id = tasks.registerTask(
        entry.name,
        "delete",
        entry.size
      );
      try {
        await invoke("sftp_remove_path", {
          job: {
            ...connection,
            id,
            local: "",
            remote: entry.path
          }
        });
      } catch (reason) {
        if (tasks.failTask(id, String(reason)))
          return;
        throw reason;
      }
      tasks.finishTask(id);
      void navigateRemote(
        session as SavedSession,
        remote?.path,
        true
      );
    },
    [
      remoteConnection,
      remote?.path,
      local?.path,
      session,
      tasks,
      navigateRemote,
      navigateLocal
    ]
  );

  /** 重命名文件或目录：新名字拼在原目录后面，目录本身不变。 */
  const renameEntry = useCallback(
    async (
      pane: PaneSide,
      entry: PaneEntry,
      name: string
    ) => {
      const directory =
        pane === "local"
          ? local?.path
          : remote?.path;
      if (!directory) {
        throw new Error(
          pane === "local"
            ? "本地目录尚未加载"
            : "远程目录尚未加载"
        );
      }
      const from = entry.path;
      const to = joinPath(directory, name);
      if (from === to) return;
      if (pane === "local") {
        await invoke("fs_rename_path", {
          from,
          to
        });
        void navigateLocal(directory);
        return;
      }
      const connection = await remoteConnection();
      await invoke("sftp_rename_path", {
        request: { ...connection, from, to }
      });
      void navigateRemote(
        session as SavedSession,
        directory,
        true
      );
    },
    [
      remoteConnection,
      remote?.path,
      local?.path,
      session,
      navigateRemote,
      navigateLocal
    ]
  );

  /** 修改远程文件 / 目录的权限（Unix 概念，仅远程栏使用）。 */
  const changeMode = useCallback(
    async (entry: PaneEntry, mode: number) => {
      const directory = remote?.path;
      const connection = await remoteConnection();
      await invoke("sftp_chmod", {
        job: {
          ...connection,
          local: "",
          remote: entry.path
        },
        mode
      });
      void navigateRemote(
        session as SavedSession,
        directory,
        true
      );
    },
    [
      remoteConnection,
      remote?.path,
      session,
      navigateRemote
    ]
  );

  /** 复制：只记入内部剪贴板，粘贴时才真正执行。 */
  const copyToClipboard = useCallback(
    (pane: PaneSide, entry: PaneEntry) => {
      setClipboard({ pane, path: entry.path });
    },
    []
  );

  /** 粘贴：同栏走本地复制，跨栏走传输。 */
  const pasteInto = useCallback(
    async (pane: PaneSide) => {
      if (!clipboard) return;
      if (clipboard.pane === pane) {
        if (pane === "local") {
          const directory = local?.path;
          if (!directory) {
            throw new Error("本地目录尚未加载");
          }
          await invoke("fs_copy_path", {
            from: clipboard.path,
            to: directory
          });
          void navigateLocal(directory);
          return;
        }
        throw new Error("远程之间的复制暂不支持");
      }
      // 跨栏粘贴 = 上传 / 下载
      await transferFile(clipboard.pane, {
        name: baseName(clipboard.path),
        path: clipboard.path,
        isDir: false,
        size: 0
      });
    },
    [
      clipboard,
      local?.path,
      navigateLocal,
      transferFile
    ]
  );

  // 首屏：挂载（或换会话）时拉两侧目录。
  // 依赖都是稳定的 useCallback，因此只在会话变化时重新加载。
  useEffect(() => {
    if (!session) return;
    // 放进微任务：加载首屏会写状态，直接在 effect 体内调用会被
    // react-hooks/set-state-in-effect 判为级联渲染
    void Promise.resolve().then(() => {
      void navigateLocal();
      // 本机终端没有远程目录，只有 SSH 会话才连 SFTP
      if (session.kind === "ssh")
        void navigateRemote(session);
    });
  }, [session, navigateLocal, navigateRemote]);

  // 返回值做 memo：调用方可以安全地把它整体放进 useCallback 依赖，
  // 也不会因为每次渲染新建对象而打穿下层组件的 memo。
  return useMemo(
    () => ({
      session,
      local,
      localError,
      remote,
      remoteError,
      remoteBusy,
      canPaste: clipboard !== null,
      transfers: tasks.transfers,
      navigateLocal,
      navigateRemote,
      openEntry,
      transferFile,
      transferEntries,
      createEntry,
      removeEntry,
      renameEntry,
      changeMode,
      copyToClipboard,
      pasteInto,
      clearTransfers,
      controlTransfer
    }),
    [
      session,
      local,
      localError,
      remote,
      remoteError,
      remoteBusy,
      clipboard,
      tasks,
      navigateLocal,
      navigateRemote,
      openEntry,
      transferFile,
      transferEntries,
      createEntry,
      removeEntry,
      renameEntry,
      changeMode,
      copyToClipboard,
      pasteInto,
      clearTransfers,
      controlTransfer
    ]
  );
}
