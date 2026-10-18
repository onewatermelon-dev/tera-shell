import {
  useEffect,
  useMemo,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
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
import TerminalWorkspace from "@/terminal/components/TerminalWorkspace";
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
  const { error, setError, fail } = useAppToast();

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

  // 底部状态栏形态（快捷宏 ⇆ 信息栏）同样落盘
  const statusMode =
    appSettings.settings.statusMode;
  /** 切换底部状态栏形态并落盘。 */
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
    notifications.notifyCommand
  );

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
      console.warn(
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
  const loading = useAppLoading(openFirstSession);

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
        statusMode={statusMode}
        onToggleStatus={toggleStatusMode}
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
          onCreateGroup={dialogs.openCreateGroup}
          onEditGroup={dialogs.openEditGroup}
          onRemoveGroup={dialogs.setGroupToRemove}
          onCreateInGroup={
            dialogs.openCreateInGroup
          }
          onMove={move}
        />
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
        t={t}
        passwordRequest={
          terminals.passwordRequest
        }
        onSubmitPassword={
          terminals.submitPassword
        }
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
        appReady={loading.appReady}
        appLoadingRef={loading.appLoadingRef}
        onLoadingFinished={
          loading.handleLoadingFinished
        }
      />
    </main>
  );
}
