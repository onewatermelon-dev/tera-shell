/**
 * 目录栏：当前会话的工作目录（OSC 7 实时跟随）。
 *
 * 数据源是远端 shell 在每个提示符前发来的 `OSC 7;file://host/path` ——
 * `cd` 之后这里自动跟着走，不需要用户手动刷新，也不用轮询。
 *
 * 交互：单击目录进入、点面包屑跳层、**双击文件把路径插进终端**
 * （不执行，用户自己决定回车）。
 *
 * 与 SFTP 面板的分工：SFTP 是双栏（本地↔远程）传文件用的；这里是
 * 「终端跑到哪个目录了，旁边就能看见」，只读浏览、单栏跟随。
 */
import {
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import {
  ArrowUpOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import EntryIcon from "@/sftp/components/panes/EntryIcon";
import { useT } from "@/settings/lib/i18n";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import { buildRemoteConnection } from "@/sftp/lib/sftpConnection";
import {
  parentOf,
  type PaneEntry,
  type PaneListing
} from "@/sftp/lib/sftpUtils";

/**
 * 读一个目录：本地走 `fs_list_dir`，远程走 `sftp_list`。
 *
 * @param session 目标会话
 * @param path 绝对路径
 */
async function listDirectory(
  session: OpenSession,
  path: string | null
): Promise<PaneListing> {
  if (session.kind === "local")
    return invoke<PaneListing>("fs_list_dir", {
      path
    });
  const connection =
    await buildRemoteConnection(session);
  return invoke<PaneListing>("sftp_list", {
    request: {
      ...connection,
      path,
      refresh: false
    }
  });
}

export default function DirectoryPanel({
  session,
  cwd,
  onInsertPath
}: {
  /** 活动会话；没有活动会话时显示空状态 */
  session?: OpenSession;
  /** 该会话当前的工作目录（OSC 7 报上来的，空串 = 还没收到） */
  cwd: string;
  /** 把路径插进终端（不执行） */
  onInsertPath: (text: string) => void;
}) {
  const t = useT();
  // 初值取当前 cwd；cwd 变化由父级换 key 重挂载（见 App），所以这里
  // 不需要「cwd 变了同步 path」的 effect —— 那条同步 setState 既会被
  // lint 拦，也容易和手动浏览打架。
  // ⚠️ **null 不只是「空」**：它表示「用会话的默认目录」（远程是登录后的
  // 家目录、本地是用户主目录）。新会话刚打开时还没收到 OSC 7，
  // 拿 null 去读一次就能立刻列出文件，而不是干等上报。
  const [path, setPath] = useState<string | null>(
    cwd || null
  );
  const [listing, setListing] =
    useState<PaneListing | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  /** 点刷新时 +1，仅用来让下面的 effect 重跑（同一个 path 不会重读） */
  const [reloadToken, setReloadToken] =
    useState(0);
  /** 家目录缓存（`~` 展开用；确认后不再重复读） */
  const homeRef = useRef<string | null>(null);

  // 目录变了就重读；切走时丢弃在途结果（响应乱序会写错栏）。
  // ⚠️ 这里只在**异步回调**里 setState：effect 体内同步 setState 会
  // 触发连锁渲染（react-hooks/set-state-in-effect）。
  useEffect(() => {
    if (!session) return;
    let alive = true;

    /**
     * `~` 开头的路径要先展开：提示符推断（没有 OSC 7 时的兜底）只能给出
     * `~` 或 `~/proj`，家目录在哪儿得问后端 —— `path: null` 的列表结果
     * 里的 `path` 就是它。缓存住，避免每次 cd 都多读一遍目录。
     */
    const resolve = async (
      target: string | null
    ): Promise<string | null> => {
      if (!target || !target.startsWith("~"))
        return target;
      if (!homeRef.current) {
        homeRef.current = (
          await listDirectory(session, null)
        ).path;
      }
      return target === "~"
        ? homeRef.current
        : `${homeRef.current}${target.slice(1)}`;
    };

    resolve(path)
      .then(target =>
        listDirectory(session, target)
      )
      .then(result => {
        if (!alive) return;
        setListing(result);
        setError("");
        setSelected("");
      })
      .catch(reason => {
        if (!alive) return;
        setError(String(reason));
        setListing(null);
      });
    return () => {
      alive = false;
    };
  }, [session, path, reloadToken]);

  // 当前实际显示的目录：列表回来之前先用请求的路径（null 时为空串）
  const currentPath = listing?.path ?? path ?? "";
  // 加载中的判定不另设 state：还没有列表，或者列表不是这一路径，
  // 就说明在等结果
  const loading =
    !!session &&
    (!listing ||
      (path !== null && listing.path !== path));

  /**
   * 面包屑：Windows 盘符路径（`C:/Users/x`）的第一段是 `C:/`，
   * 不是 `/`，否则点回到根会拼出 `/C:/Users` 这种不存在的路径。
   */
  const drive = /^([A-Za-z]:)\//.exec(
    currentPath
  );
  const root = drive ? `${drive[1]}/` : "/";
  const restPath = drive
    ? currentPath.slice(root.length)
    : currentPath.replace(/^\//, "");
  const crumbs = restPath
    .split("/")
    .filter(Boolean);

  const entries = listing?.entries ?? [];

  function open(entry: PaneEntry) {
    if (entry.isDir) setPath(entry.path);
  }

  return (
    // 复用 .sidebar 类：收起侧栏（.workspace.sidebar-closed）时靠它
    // 一起隐藏，网格也从两列变一列 —— 否则目录栏会顶到整宽的位置上
    <aside className="sidebar directory-panel">
      <div className="directory-head">
        <span
          className="directory-session"
          title={session?.name}
        >
          {session?.name ??
            t("directory.noSession")}
        </span>
        <span className="directory-actions">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={t("directory.up")}
            isDisabled={!currentPath}
            onPress={() =>
              setPath(parentOf(currentPath))
            }
          >
            <ArrowUpOutlined />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={t("directory.refresh")}
            isDisabled={!currentPath}
            onPress={() =>
              setReloadToken(n => n + 1)
            }
          >
            <ReloadOutlined />
          </Button>
        </span>
      </div>

      <div className="directory-crumbs">
        <button
          type="button"
          className="directory-crumb"
          onClick={() => setPath(root)}
        >
          {root}
        </button>
        {crumbs.map((part, index) => {
          const target = `${root}${crumbs
            .slice(0, index + 1)
            .join("/")}`;
          return (
            <button
              key={target}
              type="button"
              className="directory-crumb"
              onClick={() => setPath(target)}
              title={target}
            >
              {part}
            </button>
          );
        })}
      </div>

      <div className="directory-list">
        {!session ? (
          <p className="directory-empty">
            {t("directory.noSession")}
          </p>
        ) : error ? (
          <p className="directory-empty">
            {error}
          </p>
        ) : loading && entries.length === 0 ? (
          <p className="directory-empty">
            {t("directory.loading")}
          </p>
        ) : entries.length === 0 ? (
          <p className="directory-empty">
            {t("directory.emptyDir")}
          </p>
        ) : (
          entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              className="directory-row"
              data-selected={
                selected === entry.path
              }
              data-busy={loading}
              onClick={() => {
                setSelected(entry.path);
                open(entry);
              }}
              // 文件双击才插入路径：单击误触会把路径敲进终端，太吵
              onDoubleClick={() => {
                if (!entry.isDir)
                  onInsertPath(entry.path);
              }}
              title={entry.path}
            >
              {/* 与 SFTP 面板同一套图标：后端给的系统原生 PNG，
                  取不到时退回内置线性图标 */}
              <EntryIcon
                entry={entry}
                icons={listing?.icons}
              />
              <span className="directory-name">
                {entry.name}
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
