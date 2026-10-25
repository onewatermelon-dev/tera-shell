import {
  logError,
  logWarn
} from "@/shared/lib/log";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  restoreWindowState,
  useWindowStatePersistence
} from "@/app/lib/windowState";
import { useSessions } from "@/sessions/lib/useSessions";
import { useSessionGroups } from "@/sessions/lib/useSessionGroups";
import { useTerminals } from "@/terminal/lib/session/useTerminals";
import { useNotifications } from "@/lib/useNotifications";
import {
  resolveColorScheme,
  toSelectionCss
} from "@/terminal/lib/pane/colorSchemes";
import { useT } from "@/settings/lib/i18n";
import AppHeader from "@/app/components/AppHeader";
import SessionSidebar from "@/sessions/components/SessionSidebar";
import DirectoryPanel from "@/terminal/components/directory/DirectoryPanel";
import type { SidebarMode } from "@/app/components/AppRail";
import TerminalWorkspace from "@/terminal/components/TerminalWorkspace";
import { PasteGuardDialog } from "@/terminal/components/workspace/PasteGuardDialog";
import {
  hostKeyOf,
  hostLabelOf
} from "@/terminal/lib/commandHistory";
import { useSettings } from "@/settings/lib/useSettings";
import { refocusAfterAction } from "@/shared/lib/keepTerminalFocus";
import SettingsPage from "@/settings/components/SettingsPage";
import { useMacros } from "@/terminal/lib/macro/useMacros";
import type { TerminalMacro } from "@/terminal/lib/macro/terminalMacros";
import { broadcastTargets } from "@/terminal/lib/macro/macroBroadcast";
import AppDialogs from "@/app/components/AppDialogs";
import { useAppToast } from "@/app/lib/useAppToast";
import { useAppDialogs } from "@/app/lib/useAppDialogs";
import { useAppLoading } from "@/app/lib/useAppLoading";
import { useTerminalSelection } from "@/app/lib/useTerminalSelection";
import { buildHeaderActions } from "@/app/lib/headerActions";
import { askAiFromTerminal } from "@/terminal/lib/ai/askFromTerminal";
import { useWatch } from "@/watch/lib/useWatch";
import {
  layoutOf,
  loadLayout,
  saveLayout
} from "@/terminal/lib/session/terminalLayout";
import WatchDialog from "@/watch/components/WatchDialog";
import WatchPanel from "@/watch/components/WatchPanel";
import type { SavedSession } from "@/sessions/lib/session";
import "@xterm/xterm/css/xterm.css";
import "@/styles/app.scss";
import "@/styles/main.css";

/**
 * 应用外壳：顶栏 + 会话侧栏 + 终端工作区 + 各类弹窗。
 *
 * 本文件只做「组装」—— 状态与业务逻辑按域拆在 lib/ 下：
 * - `useAppToast`      右下角错误气泡
 * - `useAppDialogs`    会话/分组弹窗状态与处理（含导入导出）
 * - `useAppLoading`    开场动效与就绪状态
 * - `useTerminalSelection` 活动终端选区订阅
 * - `headerActions`    标题栏菜单动作表
 * 底部弹窗 JSX 住在 `AppDialogs` 组件里。
 */
export default function App() {
  const t = useT();
  const { error, setError, fail, notify } =
    useAppToast();

  const macroStore = useMacros();

  const sessionStore = useSessions();
  const groupStore = useSessionGroups();
  const dialogs = useAppDialogs({
    sessionStore,
    groupStore,
    t,
    setError
  });
  const {
    query,
    setQuery,
    filteredSessions,
    move
  } = sessionStore;
  const { groups, toggle: toggleGroup } =
    groupStore;

  const [settingsOpen, setSettingsOpen] =
    useState(false);
  const [macroOpen, setMacroOpen] =
    useState(false);
  /** 正在配置值守巡检的会话；null = 弹窗关闭 */
  const [watchSession, setWatchSession] =
    useState<SavedSession | null>(null);
  /** 右侧值守面板（状态 / 班报）是否展开 */
  const [watchOpen, setWatchOpen] =
    useState(false);
  // 编辑中的宏；为 null 表示本次弹窗是「新增」
  const [editingMacro, setEditingMacro] =
    useState<TerminalMacro | null>(null);

  // 显示偏好：字体、字号、主题。必须早于 useTerminals —— 终端要用它建实例
  const appSettings = useSettings();

  // 会话栏展开 ⇆ 收起直接读写显示偏好，重启后保持上次的形态
  const sidebarOpen =
    appSettings.settings.sidebarOpen;
  /** 切换会话栏显隐并落盘。 */
  function toggleSidebar() {
    appSettings.update({
      sidebarOpen: !sidebarOpen
    });
    refocusAfterAction(refocusActive);
  }

  /**
   * 侧栏内容：会话列表 ⇆ 跟随目录。
   *
   * 不落盘：重启回到会话列表更符合预期（目录是「当前正在干什么」的
   * 临时视图，不是长期偏好）。
   */
  const [sidebarMode, setSidebarMode] =
    useState<SidebarMode>("sessions");

  /** 竖条上的切换按钮；侧栏收着时顺手展开，否则点了像没反应。 */
  function toggleSidebarMode() {
    const next =
      sidebarMode === "sessions"
        ? "directory"
        : "sessions";
    setSidebarMode(next);
    if (next === "directory" && !sidebarOpen) {
      appSettings.update({ sidebarOpen: true });
    }
    refocusAfterAction(refocusActive);
  }

  // 底部状态栏形态（快捷宏 ⇆ 信息栏）同样落盘
  const statusMode =
    appSettings.settings
      .statusMode; /** 切换底部状态栏形态并落盘。 */
  function toggleStatusMode() {
    appSettings.update({
      statusMode:
        statusMode === "macros"
          ? "info"
          : "macros"
    });
    refocusAfterAction(refocusActive);
  }

  /**
   * Ctrl + 滚轮缩放字号后的落地：写回设置。
   *
   * 写盘即「记忆」—— 下次启动仍是这个字号；同时外观 effect 会把
   * 新字号推给所有已打开的终端（含拆分窗格）。
   */
  function setTerminalFontSize(fontSize: number) {
    appSettings.update({ fontSize });
  }

  // 系统通知：开关与窗口焦点由 hook 统一判，这里只提供接线
  const notifications = useNotifications(
    appSettings.settings
  );

  /**
   * 值守巡检：心跳由后端发，采样复用 AI 的 exec 通道，
   * 判定是纯函数，通知走上面那套开关与焦点判定。
   *
   * 放在 App 层是因为它**与会话是否打开无关** —— 值守盯的是已保存的
   * 服务器，不是「用户正开着的标签」。
   */
  const watch = useWatch({
    sessions: sessionStore.sessions,
    notify: notifications.notifyWatch,
    onError: setError
  });

  const terminals = useTerminals(
    // 已关闭/已断开的会话上迟到的 write/resize 只会得到这个错误，
    // 对用户毫无价值 —— 静默丢弃，其它错误照常展示
    reason => {
      const text = String(reason);
      if (text.includes("终端会话不存在")) return;
      setError(text);
    },
    (sourceSessionId, encrypted) => {
      const session = sessionStore.sessions.find(
        item => item.id === sourceSessionId
      );
      if (session)
        sessionStore.update({
          ...session,
          password: encrypted
        });
    },
    appSettings.settings,
    setTerminalFontSize,
    // 跳板链解析的数据源：会话列表变化时重连/新连都拿最新值
    sessionStore.sessions,
    notifications.notifyCommand
  );

  /**
   * 待确认粘贴的目标会话：弹窗显示会话名 / 环境色 / 主机要用。
   *
   * 会话可能在这期间被关掉（find 返回 undefined），此时弹窗按空信息
   * 显示 —— 确认后 requestPaste 找不到会话会自然忽略。
   */
  const pasteTarget = terminals.pasteRequest
    ? terminals.opened.find(
        item =>
          item.id ===
          terminals.pasteRequest?.sessionId
      )
    : undefined;

  /**
   * 目录栏双击目录：让终端 `cd` 过去。
   *
   * 走 PTY（等价于用户自己敲了 `cd ...`），所以终端里会留下这条命令 ——
   * 这是有意的：用户随时能看见自己是怎么到这个目录的，也不会出现
   * 「终端在 A、目录栏在 B」的错位（视图由 cwd 跟随自动切）。
   *
   * 引号规则两端不同：
   * - POSIX（SSH）：单引号包裹，内部 `'` 写成 `'\''`
   * - PowerShell（本地）：单引号包裹，内部 `'` 写成 `''`
   * - 全是安全字符时不加引号，命令看着干净
   */
  function enterDirectory(path: string) {
    const target = terminals.active;
    if (!target) return;
    const remote = target.kind !== "local";
    const safe = /^[\w@%+=:,./-]+$/.test(path);
    const quoted = safe
      ? path
      : remote
        ? `'${path.replace(/'/g, `'\\''`)}'`
        : `'${path.replace(/'/g, "''")}'`;
    terminals.insertText(
      target.id,
      `cd ${quoted}\r`
    );
  }

  /**
   * 错误提示里的一键导出诊断包。
   *
   * 结果复用同一个气泡显示（成功也是「已保存到 …」）—— 用户此刻只关心
   * 「东西给出来了没有、在哪」，不必再开一个成功弹窗。
   */
  function exportDiagnosticsFromToast() {
    invoke<{ path: string; files: number }>(
      "diagnostics_export",
      { days: 3 }
    )
      .then(info => {
        console.info(
          "[diagnostics] 诊断包已生成",
          info
        );
        // 成功提示不该记成 error：走 notify（只显示不落盘）
        notify(
          t("about.diagnostics.done", {
            path: info.path,
            files: info.files
          })
        );
      })
      .catch((reason: unknown) => {
        logError(
          "[diagnostics] 导出失败",
          reason
        );
        setError(String(reason));
      });
  }

  /**
   * 值守 → AI 归因：把打包好的现场送进 AI 面板。
   *
   * AI 面板挂在**当前活动终端**上，而被巡检的会话未必开着，所以分两条路：
   * 1. 已有面板在听 → 直接发；
   * 2. 没有 → 先把该会话的终端打开（会挂上 AiPanel），再重试补发 ——
   *    面板挂载是下一帧的事，`askAiFromTerminal` 此刻必然没人接。
   *
   * 重试封顶 ~1.5 秒：密码框/密钥认证的会话可能要更久才把面板挂上，
   * 但无限等下去只会让用户点了按钮之后毫无反馈，不如早点放弃并提示。
   *
   * @returns false = 彻底发不出去（本地会话 / 会话找不到），调用方据此提示
   */
  function askAiFromWatch(
    text: string,
    sessionId: string
  ): boolean {
    if (askAiFromTerminal("diagnose", text))
      return true;
    const session = sessionStore.sessions.find(
      item => item.id === sessionId
    );
    if (!session || session.kind !== "ssh")
      return false;
    console.info(
      `[watch] AI 面板未就绪，先打开会话终端：${sessionId}`
    );
    terminals.open(session);
    let tries = 0;
    const retry = () => {
      if (askAiFromTerminal("diagnose", text))
        return;
      tries += 1;
      if (tries > 30) {
        logWarn(
          "[watch] AI 面板迟迟未就绪，归因请求已放弃"
        );
        return;
      }
      window.setTimeout(retry, 50);
    };
    window.setTimeout(retry, 50);
    return true;
  }

  /**
   * 把标签甩到独立窗口。
   *
   * 顺序不能反：**先开窗、再摘标签**。反过来的话开窗失败时标签已经没了，
   * 会话还在后台跑，用户既看不到也关不掉。
   * 摘标签时带 `keepSession` —— 会话被新窗口接管，不能 terminal_close。
   */
  async function detachToWindow(id: string) {
    const session = terminals.opened.find(
      item => item.id === id
    );
    if (!session) return;
    try {
      await invoke("open_terminal_window", {
        sessionId: id,
        title: session.name,
        // dup- 临时会话不落库，独立窗口按 source 才能取到会话信息
        sourceSessionId: session.sourceSessionId,
        // 落在主窗口右下方一点，避免正好盖住原来的位置
        x: window.screenX + 120,
        y: window.screenY + 80
      });
      await terminals.close(id, {
        keepSession: true
      });
      console.info(
        "[terminal] 已外置到独立窗口：",
        id
      );
    } catch (reason) {
      logError(
        "[terminal] 外置到独立窗口失败",
        reason
      );
      setError(String(reason));
    }
  }

  /**
   * 目录栏的「打开 SFTP」：带着当前目录开一个独立 SFTP 窗口。
   *
   * 路径在这里就编码好：后端只把字符串拼到 URL 上，重复编码会把中文
   * 目录名写成 %25E4%25B8…，那边就打不开了。
   */
  function openSftpAt(path: string) {
    const target = terminals.active;
    if (!target) return;
    invoke("open_sftp_window", {
      // 传 sourceSessionId：复制出来的会话 id 是临时的，独立窗口取不到
      sessionId: target.sourceSessionId,
      title: target.name,
      initialPath: path
        ? encodeURIComponent(path)
        : ""
    }).catch((reason: unknown) =>
      setError(String(reason))
    );
  }

  /**
   * 目录栏双击文件：把路径插进终端（不执行）。
   *
   * 含空格的路径加引号，否则粘进 shell 会被拆成多个参数。
   */
  function insertPath(path: string) {
    const target = terminals.active;
    if (!target) return;
    const text = /\s/.test(path)
      ? `"${path}"`
      : path;
    terminals.insertText(target.id, text);
  }

  /** 把键盘焦点还给活动终端（竖条按钮动作 / 菜单关闭后的焦点回还）。 */
  function refocusActive() {
    if (terminals.active)
      terminals.focusTerminal(
        terminals.active.id
      );
  }

  // 从设置页返回终端页时把键盘焦点交还活动终端：这是应用内切换，
  // 系统焦点从未离开窗口，window 的 focus 事件不会触发，必须显式还
  useEffect(() => {
    if (!settingsOpen) refocusActive();
    // terminals 每渲染都是新对象，进依赖会让 effect 每渲染都跑；
    // 只跟踪真正影响行为的 settingsOpen
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上
  }, [settingsOpen]);

  // 会话编辑 / 宏管理 / 密码弹窗关闭后，同样把焦点还给终端
  const anyDialogOpen =
    dialogs.dialogOpen ||
    macroOpen ||
    !!terminals.passwordRequest;
  useEffect(() => {
    if (!anyDialogOpen) refocusActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
  }, [anyDialogOpen]);

  /** 打开本机终端：会话列表里固定的 local 会话，标题栏菜单与空状态共用。 */
  function openLocal() {
    const local = sessionStore.sessions.find(
      session => session.kind === "local"
    );
    if (local) terminals.open(local);
    else setError("未找到本机终端会话");
  }

  /**
   * 执行一条快捷宏：把命令写进当前聚焦的窗格（左栏或某个拆分栏），每行补一个回车。
   *
   * 多行宏按**逐行下发**处理 —— 等价于在终端里依次敲下每一行，
   * 这也是把几步操作串成一条宏的本意。空行跳过，免得刷出一堆空回车。
   *
   * `command` 一并传过去，后端用它记录命令历史（与手动敲入的处理一致）。
   * 执行完把焦点交回该窗格终端，方便接着敲。
   */
  function runMacro(
    macro: TerminalMacro,
    targetId: string
  ) {
    const id = targetId;
    if (!id) return;
    const lines = macro.command
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== "");
    if (lines.length === 0) return;
    invoke("terminal_write", {
      id,
      data: lines
        .map(line => `${line}\r`)
        .join(""),
      command: macro.command
    }).catch(fail);
    requestAnimationFrame(() =>
      terminals.focusTerminal(id)
    );
  }

  /**
   * 把一条快捷宏发送到**所有**已打开的会话标签。
   *
   * ## 为什么不能直接 forEach 调 runMacro
   *
   * `runMacro` 末尾有 `focusTerminal(id)`（执行完把焦点交回目标窗格，
   * 方便用户接着敲）。批量调用会让焦点在最后一跳结束，且每个 id 都触发
   * 一次 `focus()` —— 多标签下表现为**焦点在屏幕上连番跳窜**。
   * 广播的语义是「往每只会话都发一份」，用户并没有要切到哪一只。
   *
   * 所以这里只下发、最后把焦点**还给原来那只**（用户正对着的那只），
   * 位置与点菜单前一致。
   *
   * ## 为什么逐个 invoke 而不是合并成一次
   *
   * `terminal_write` 的入参是单个会话 id，没有批量形式。多行宏也是
   * 逐行补回车拼成一个 data 串（与 runMacro 同规则），所以「N 个会话」
   * 就是 N 次 invoke —— 命令是 fire-and-forget，不等返回。
   */
  function broadcastMacro(macro: TerminalMacro) {
    const lines = macro.command
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== "");
    if (lines.length === 0) return;
    const data = lines
      .map(line => `${line}\r`)
      .join("");
    const { ids, skipped } = broadcastTargets(
      terminals.opened,
      terminals.disconnected,
      terminals.activeId
    );
    if (ids.length === 0) {
      logWarn(
        "[macro] 没有可发送的会话标签，已放弃广播"
      );
      setError(t("macro.broadcastNone"));
      return;
    }
    for (const id of ids) {
      invoke("terminal_write", {
        id,
        data,
        command: macro.command
      }).catch(fail);
    }
    // 关键日志：排查「发了没反应」时看实际落到了哪几个会话
    console.info(
      `[macro] 已广播到 ${ids.length} 个会话标签（跳过 ${skipped}）`
    );
    if (skipped > 0) {
      // 跳过的要说出来：用户以为「发到所有」就是全发了，
      // 少了几个却不说，他会以为是服务器没响应
      setError(
        t("macro.broadcastSkipped", {
          count: ids.length,
          skipped
        })
      );
    } else {
      console.info(
        t("macro.broadcastDone", {
          count: ids.length
        })
      );
    }
    // 焦点交回用户原本正看着的那只，而不是最后被写的那只
    requestAnimationFrame(refocusActive);
  }

  /** 开场后载入第一个会话：原 useAppLoading effect 的策略，
   * 「开哪个」是业务决策留在门面，hook 只管时机。 */
  const openFirstSession = () => {
    const first = sessionStore.sessions[0];
    if (first) terminals.open(first);
  };
  /**
   * 布局存档是否已经「初始化完毕」。
   *
   * 还原**之前**不能写盘：那时的运行态是「一只都没开」或「开了一半」，
   * 写进去就把上次的存档覆盖成空的了。用 state 而不是 ref：置为 true
   * 会让下面的存档 effect 重新跑一次（把还原后的最终布局写下去）。
   */
  const [layoutReady, setLayoutReady] =
    useState(false);

  /**
   * 开场策略：优先还原上次的标签与分屏；没有存档、或一个都没还原成功，
   * 才回落到「开第一个会话」。
   */
  const restoreOrOpenFirst = () => {
    const saved = appSettings.settings
      .restoreLayout
      ? loadLayout()
      : null;
    if (!saved) {
      setLayoutReady(true);
      openFirstSession();
      return;
    }
    void terminals
      .restore(saved)
      .then(result => {
        setLayoutReady(true);
        if (result.restored === 0) {
          // 存档里的会话全没了（被删了 / 都要密码）：按老规矩开第一个
          openFirstSession();
          return;
        }
        console.info(
          `[layout] 已还原 ${result.restored} 个标签${
            result.skipped.length
              ? `，跳过 ${result.skipped.length} 个（会话已删除或需要密码）`
              : ""
          }`
        );
      })
      .catch(reason => {
        // 还原过程中出错（比如某只会话启动抛异常）：别把用户卡在
        // 「一个标签都没有」的空状态里
        console.warn(
          "[layout] 还原失败，按「开第一个会话」处理",
          reason
        );
        setLayoutReady(true);
        openFirstSession();
      });
  };
  const loading = useAppLoading(
    restoreOrOpenFirst
  );

  /**
   * 窗口在桌面的位置与大小：启动时恢复，之后移动/缩放都记着。
   *
   * 只对主窗口生效 —— 独立开的 SFTP / 终端窗口有自己的位置语义
   * （贴边、临时弹出），不该被主窗口的存档覆盖。
   */
  useWindowStatePersistence();
  useEffect(() => {
    void restoreWindowState();
  }, []);

  /**
   * 布局存档：标签/分屏一变就写盘（去抖 400ms）。
   *
   * 去抖是为了拖分隔条 —— 那是连续事件，每帧写一次磁盘没道理。
   * 还原过程**不写**（layoutReady 还没置位），否则会把存档覆盖成半成品。
   */
  useEffect(() => {
    if (!layoutReady) return;
    const timer = window.setTimeout(() => {
      saveLayout(
        layoutOf(
          terminals.opened,
          terminals.panes,
          terminals.tree,
          terminals.activePaneId
        )
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    layoutReady,
    terminals.opened,
    terminals.panes,
    terminals.tree,
    terminals.activePaneId
  ]);

  // 菜单"复制"的可用性跟随终端选区
  const hasSelection = useTerminalSelection(
    terminals.active?.terminal
  );

  const menuState = useMemo(
    () => ({
      hasActive: Boolean(terminals.active),
      hasSelection
    }),
    [terminals.active, hasSelection]
  );

  // 标题栏菜单动作：读写剪贴板失败统一走右下角错误提示
  const headerActions = buildHeaderActions({
    terminals,
    fail,
    openCreate: dialogs.openCreate,
    openLocal,
    exportSessions: dialogs.exportSessions,
    importSessions: dialogs.importSessions,
    refocusActive,
    openSettings: () => setSettingsOpen(true)
  });

  // 终端配色方案的背景/前景/选区下传给 CSS：.terminal-host 的余数缝隙要跟
  // xterm 背景融为一体、划词覆盖层要用它做高亮 —— CSS 拿不到
  // xterm 主题，走变量
  const scheme = resolveColorScheme(
    appSettings.settings.colorScheme
  );

  return (
    <main
      className={
        settingsOpen
          ? "shell-app settings-open"
          : "shell-app"
      }
      style={
        {
          "--terminal-bg": scheme.background,
          "--terminal-fg": scheme.foreground,
          // 选区色：格式是完整的 color-mix() 表达式（见 toSelectionCss），
          // 混入了终端背景色以保证文字不被压没
          "--terminal-selection":
            toSelectionCss(scheme)
        } as Record<string, string>
      }
    >
      <AppHeader
        actions={headerActions}
        menuState={menuState}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        sidebarMode={sidebarMode}
        onToggleSidebarMode={toggleSidebarMode}
        statusMode={statusMode}
        onToggleStatus={toggleStatusMode}
        watchOpen={watchOpen}
        onToggleWatch={() =>
          setWatchOpen(open => !open)
        }
        hideMenus={settingsOpen}
        onMenuClosed={() =>
          refocusAfterAction(refocusActive)
        }
      />
      <section
        className={
          sidebarOpen
            ? "workspace"
            : "workspace sidebar-closed"
        }
      >
        {sidebarMode === "sessions" ? (
          <SessionSidebar
            sessions={filteredSessions}
            groups={groups}
            activeId={
              terminals.active?.sourceSessionId ??
              ""
            }
            openedCount={terminals.opened.length}
            query={query}
            onQueryChange={setQuery}
            onDuplicate={terminals.duplicate}
            onEdit={dialogs.openEdit}
            onRemove={dialogs.setSessionToRemove}
            onCreate={dialogs.openCreate}
            onToggleGroup={toggleGroup}
            onCreateGroup={
              dialogs.openCreateGroup
            }
            onEditGroup={dialogs.openEditGroup}
            onRemoveGroup={
              dialogs.setGroupToRemove
            }
            onWatch={setWatchSession}
            onCreateInGroup={
              dialogs.openCreateInGroup
            }
            onMove={move}
          />
        ) : (
          <DirectoryPanel
            // cwd 一变就重挂：组件内部无需「跟随」effect，
            // 顺带把列表与滚动位置一起重置到新目录
            key={`${terminals.active?.id ?? ""}:${terminals.activeCwd}`}
            session={terminals.active}
            cwd={terminals.activeCwd}
            onInsertPath={insertPath}
            onEnterDirectory={enterDirectory}
            onOpenSftp={openSftpAt}
          />
        )}
        <TerminalWorkspace
          opened={terminals.opened}
          active={terminals.active}
          disconnected={terminals.disconnected}
          searchOpen={terminals.searchOpen}
          searchResult={terminals.searchResult}
          searchError={terminals.searchError}
          searchCaseSensitive={
            terminals.searchCaseSensitive
          }
          searchRegex={terminals.searchRegex}
          historyOpen={terminals.historyOpen}
          historyHost={terminals.historyHost}
          onInsertHistory={
            terminals.insertHistory
          }
          onCloseHistory={
            terminals.closeHistorySearch
          }
          failures={terminals.failures}
          onDiagnoseFailure={
            terminals.diagnoseFailure
          }
          onDismissFailure={
            terminals.clearFailure
          }
          onFocusTerminal={
            terminals.focusTerminal
          }
          onResize={terminals.resize}
          onPausePtySync={terminals.pausePtySync}
          onClose={terminals.close}
          onCloseTabs={terminals.closeMany}
          panes={terminals.panes}
          tree={terminals.tree}
          activePaneId={terminals.activePaneId}
          onPaneHost={terminals.setPaneHost}
          onFocusPane={terminals.setActivePaneId}
          onActivatePaneTab={
            terminals.activatePaneTab
          }
          onPaneRatio={terminals.setPaneRatio}
          onDetach={id => void detachToWindow(id)}
          onSplitPane={terminals.splitPane}
          onMoveTab={terminals.moveTab}
          onReorderTab={terminals.reorderTab}
          onCreate={dialogs.openCreate}
          onOpenLocal={openLocal}
          onSearch={terminals.search}
          onCloseSearch={terminals.closeSearch}
          onToggleCaseSensitive={
            terminals.toggleCaseSensitive
          }
          onToggleRegex={terminals.toggleRegex}
          macros={macroStore.macros}
          onRunMacro={runMacro}
          onBroadcastMacro={broadcastMacro}
          onAddMacro={() => {
            setEditingMacro(null);
            setMacroOpen(true);
          }}
          // AI 卡片一键存宏：名称用卡片说明，留空按既有约定用命令兜底
          onAddMacroCommand={macroStore.add}
          onEditMacro={macro => {
            setEditingMacro(macro);
            setMacroOpen(true);
          }}
          onDeleteMacro={macro =>
            macroStore.remove(macro.id)
          }
          onReorderMacro={macroStore.reorder}
          statusMode={statusMode}
          welcomeCard={
            appSettings.settings.welcomeCard
          }
          onNotify={setError}
          setPtyResizePaused={
            terminals.setPtyResizePaused
          }
        />
        {/* 值守面板：右侧覆盖层（不挤压终端网格，见 _watch.scss 注释）。
            放在 SettingsPage 之前 —— 设置页 z-index 更高，打开时把它盖住。 */}
        {watchOpen && (
          <WatchPanel
            sessions={sessionStore.sessions}
            watch={watch}
            onClose={() => setWatchOpen(false)}
            onConfigure={setWatchSession}
            onAskAi={askAiFromWatch}
            onError={setError}
          />
        )}
        {/* 设置页盖在工作区之上（绝对定位），而不是替换它的内容 ——
            替换会让 TerminalWorkspace 卸载，xterm 的 DOM 随之被移除，
            回来时终端就空了。 */}
        {settingsOpen && (
          <SettingsPage
            settings={appSettings.settings}
            onChange={appSettings.update}
            onBack={() => setSettingsOpen(false)}
          />
        )}
      </section>
      <AppDialogs
        dialogs={dialogs}
        groups={groups}
        sessions={sessionStore.sessions}
        t={t}
        passwordRequest={
          terminals.passwordRequest
        }
        onSubmitPassword={
          terminals.submitPassword
        }
        onUseKeyAuth={terminals.useKeyAuth}
        onCancelPassword={
          terminals.cancelPassword
        }
        macroOpen={macroOpen}
        editingMacro={editingMacro}
        onSaveMacro={(name, command) => {
          if (editingMacro)
            macroStore.update(
              editingMacro.id,
              name,
              command
            );
          else macroStore.add(name, command);
        }}
        onCloseMacro={() => setMacroOpen(false)}
        error={error}
        onDismissError={() => setError("")}
        onExportDiagnostics={
          exportDiagnosticsFromToast
        }
        appReady={loading.appReady}
        appLoadingRef={loading.appLoadingRef}
        onLoadingFinished={
          loading.handleLoadingFinished
        }
      />

      {/*
        粘贴确认弹窗放在应用根部而不是终端工作区里：工作区有
        `overflow: hidden` 与自己的层叠上下文，弹层的遮罩会被裁剪或压在
        终端下面（症状就是「明明拦住了，但屏幕上什么也没出现」）。
      */}
      {terminals.pasteRequest && (
        <PasteGuardDialog
          sessionName={pasteTarget?.name ?? ""}
          host={
            pasteTarget
              ? hostLabelOf(
                  hostKeyOf(pasteTarget)
                )
              : ""
          }
          color={pasteTarget?.color}
          text={terminals.pasteRequest.text}
          assessment={
            terminals.pasteRequest.assessment
          }
          onConfirm={terminals.confirmPaste}
          onCancel={terminals.cancelPaste}
        />
      )}

      {/* 值守配置弹窗同样挂根层：终端工作区有 overflow:hidden 与自己的
          层叠上下文，弹层放里面会被裁剪或压在终端下面。
          只在需要时挂载并带 key：换会话即重挂，省掉「props 变了重置
          表单状态」那类 effect。 */}
      {watchSession && (
        <WatchDialog
          key={watchSession.id}
          session={watchSession}
          onClose={() => setWatchSession(null)}
          onSaved={watch.reload}
          onAskAi={askAiFromWatch}
          onDeleteAlert={watch.removeAlert}
        />
      )}
    </main>
  );
}
