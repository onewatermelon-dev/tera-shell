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
  Fragment,
  useEffect,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpOutlined,
  ReloadOutlined,
  SwapOutlined
} from "@ant-design/icons";
import EntryIcon from "@/sftp/components/panes/EntryIcon";
import { useT } from "@/settings/lib/i18n";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";
import { buildRemoteConnection } from "@/sftp/lib/sftpConnection";
import {
  parentOf,
  type PaneListing
} from "@/sftp/lib/sftpUtils";
import {
  ROW_HEIGHT,
  visibleRange
} from "@/terminal/components/directory/virtual";
import { onDirectoryDirty } from "@/terminal/lib/directory/dirty";

/**
 * 读一个目录：本地走 `fs_list_dir`，远程走 `sftp_list`。
 *
 * 远程恒 `refresh: true`：SFTP 后端按路径缓存列表，终端里删了文件后
 * 缓存还是旧的 —— 手动点刷新要的是**现在**的内容，必须绕开缓存。
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
      refresh: true
    }
  });
}

export default function DirectoryPanel({
  session,
  cwd,
  onInsertPath,
  onEnterDirectory,
  onOpenSftp
}: {
  /** 活动会话；没有活动会话时显示空状态 */
  session?: OpenSession;
  /** 该会话当前的工作目录（OSC 7 报上来的，空串 = 还没收到） */
  cwd: string;
  /** 把路径插进终端（不执行） */
  onInsertPath: (text: string) => void;
  /**
   * 双击目录：让终端 `cd` 过去。
   *
   * 目录栏的定位是「终端的镜像」，所以导航以终端为准 —— 双击即 cd，
   * 视图随后由 cwd 跟随自动切过去，不会出现「栏里在 A、终端在 B」。
   */
  onEnterDirectory: (path: string) => void;
  /**
   * 在当前目录打开 SFTP 面板。
   *
   * 传 path 而不是让上层自己去取：目录栏知道「用户现在看的这一层」，
   * 上层不需要再猜。
   */
  onOpenSftp: (path: string) => void;
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
  /** 滚动容器（虚拟滚动要读它的可视高度） */
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] =
    useState(0);

  // 视口高度跟着容器走：拖侧栏宽度、缩窗口都会变。
  // ResizeObserver 首次 observe 会异步回调一次，所以不必在 effect 里
  // 同步读 clientHeight（那会触发 set-state-in-effect）。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(el.clientHeight)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // 终端里 rm/touch、AI 建删文件这类不换目录的操作不会触发 OSC 7：
  // 它们完成时广播「目录可能变了」，这里收到就重读一次当前目录
  // （复用 reloadToken，effect 的在途丢弃逻辑原样生效）
  useEffect(
    () =>
      onDirectoryDirty(() =>
        setReloadToken(n => n + 1)
      ),
    []
  );

  // 当前实际显示的目录：列表回来之前先用请求的路径（null 时为空串）
  // ⚠️ Windows 本地后端给的是**反斜杠**路径（`C:\Users\x`，来自
  // to_string_lossy），这里统一成正斜杠再拆面包屑 —— 否则盘符判断
  // 匹配不上、根会退化成 `/`，地址栏就露出 `/C:\Users\x` 这种多余的前导斜杠
  const currentPath = (
    listing?.path ??
    path ??
    ""
  ).replace(/\\/g, "/");
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
  // 只渲染视口内（含缓冲）的行；start 用来把这一批整体下移
  const { start, end } = visibleRange(
    scrollTop,
    viewportHeight,
    entries.length
  );
  const visible = entries.slice(start, end);

  /**
   * 跳到一个目录：**先本地切，再让终端 cd 过去**。
   *
   * 为什么要两边都做：
   * - 只 cd 不切：钩子没生效（OSC 7 没来）时目录栏不动，点了像没反应；
   * - 只切不 cd：终端还留在原地，栏里在 A、终端在 B，跟随关系就断了。
   * 先 setPath 保证「点了立刻能看到内容」，再 cd 让终端跟上；cwd 上报
   * 之后父级换 key 重挂，两边自然一致。
   */
  function goTo(target: string) {
    setPath(target);
    onEnterDirectory(target);
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
          <button
            type="button"
            className="directory-icon-btn"
            aria-label={t("directory.up")}
            disabled={!currentPath}
            onClick={() =>
              goTo(parentOf(currentPath))
            }
          >
            <ArrowUpOutlined />
          </button>
          <button
            type="button"
            className="directory-icon-btn"
            aria-label={t("directory.refresh")}
            disabled={!currentPath}
            onClick={() =>
              setReloadToken(n => n + 1)
            }
          >
            <ReloadOutlined />
          </button>
          {/* 去 SFTP 面板：带上当前目录，那边一开就在同一位置 */}
          <button
            type="button"
            className="directory-icon-btn"
            aria-label={t("directory.openSftp")}
            disabled={!session}
            onClick={() =>
              onOpenSftp(currentPath)
            }
          >
            <SwapOutlined />
          </button>
        </span>
      </div>

      <div className="directory-crumbs">
        <button
          type="button"
          className="directory-crumb"
          onClick={() => goTo(root)}
        >
          {root}
        </button>
        {crumbs.map((part, index) => {
          const target = `${root}${crumbs
            .slice(0, index + 1)
            .join("/")}`;
          return (
            <Fragment key={target}>
              {/* 段与段之间显式画一个 /：根节点自身已经带斜杠
                  （`/` 或 `C:/`），所以第一段前面不再重复 */}
              {index > 0 && (
                <span
                  className="directory-sep"
                  aria-hidden="true"
                >
                  /
                </span>
              )}
              <button
                type="button"
                className="directory-crumb"
                onClick={() => goTo(target)}
                title={target}
              >
                {part}
              </button>
            </Fragment>
          );
        })}
      </div>

      <div
        className="directory-list"
        ref={listRef}
        onScroll={event =>
          setScrollTop(
            event.currentTarget.scrollTop
          )
        }
      >
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
          /* 虚拟滚动：外层撑满「总行数 × 行高」，内层整体平移到当前
             起始行。几万个文件的目录也只渲染视口里那几十行。 */
          <div
            className="directory-vlist"
            style={{
              height: entries.length * ROW_HEIGHT
            }}
          >
            <div
              className="directory-vrows"
              style={{
                transform: `translateY(${start * ROW_HEIGHT}px)`
              }}
            >
              {visible.map(entry => (
                <button
                  key={entry.path}
                  type="button"
                  className="directory-row"
                  data-selected={
                    selected === entry.path
                  }
                  data-busy={loading}
                  // 单击只选中：双击才是动作（目录 cd / 文件插路径），
                  // 避免手滑就把命令敲进终端
                  onClick={() =>
                    setSelected(entry.path)
                  }
                  onDoubleClick={() => {
                    if (entry.isDir)
                      goTo(entry.path);
                    else onInsertPath(entry.path);
                  }}
                  title={entry.path}
                >
                  {/* 与 SFTP 面板同一套图标：后端给的系统原生 PNG，
                      取不到时退回内置线性图标 */}
                  <EntryIcon
                    entry={entry}
                    icons={listing?.icons}
                  />
                  {/* 单行：图标 + 名称。侧栏窄，放不下大小/时间/权限列
                      （需要时看 SFTP 面板或 ls -l） */}
                  <span className="directory-name">
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
