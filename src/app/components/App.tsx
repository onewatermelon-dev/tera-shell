import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Alert } from "@heroui/react";
import { useSessions } from "@/sessions/lib/useSessions";
import { useSessionGroups } from "@/sessions/lib/useSessionGroups";
import {
  parseImportPayload,
  serializeExport,
  type ImportPreview
} from "@/sessions/lib/sessionTransfer";
import type { SessionGroup } from "@/sessions/lib/sessionGroup";
import { useTerminals } from "@/terminal/lib/useTerminals";
import { resolveColorScheme } from "@/terminal/lib/colorSchemes";
import { useT } from "@/settings/lib/i18n";
import type { SavedSession } from "@/sessions/lib/session";
import AppHeader, {
  type HeaderActions
} from "@/app/components/AppHeader";
import SessionSidebar from "@/sessions/components/SessionSidebar";
import TerminalWorkspace from "@/terminal/components/TerminalWorkspace";
import { useSettings } from "@/settings/lib/useSettings";
import { refocusAfterAction } from "@/shared/lib/keepTerminalFocus";
import SettingsPage from "@/settings/components/SettingsPage";
import { useMacros } from "@/terminal/lib/useMacros";
import MacroDialog from "@/terminal/components/MacroDialog";
import type { TerminalMacro } from "@/terminal/lib/terminalMacros";
import SessionDialog from "@/sessions/components/SessionDialog";
import GroupDialog from "@/sessions/components/GroupDialog";
import ConfirmDialog from "@/shared/components/ConfirmDialog";
import PasswordDialog from "@/sessions/components/PasswordDialog";
import AppLoading, {
  type AppLoadingHandle
} from "@/app/components/AppLoading";
import "@xterm/xterm/css/xterm.css";
import "@/styles/app.scss";
import "@/styles/main.css";

export default function App() {
  const [dialogOpen, setDialogOpen] =
    useState(false);
  const t = useT();
  const [error, setError] = useState("");
  // 错误气泡数秒后自动消失：原本只有"点击消失"这一种隐晦交互，
  // 用户不知道能点，错误会一直挂在角落（如关闭会话后残留的写失败提示）
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(
      () => setError(""),
      5000
    );
    return () => clearTimeout(timer);
  }, [error]);
  const [editingSession, setEditingSession] =
    useState<SavedSession | null>(null);
  // 分组弹窗：editingGroup 为 null 表示本次是「新建分组」
  const [groupDialogOpen, setGroupDialogOpen] =
    useState(false);
  const [editingGroup, setEditingGroup] =
    useState<SessionGroup | null>(null);
  // 待确认删除的分组（null = 没有待确认项）
  const [groupToRemove, setGroupToRemove] =
    useState<SessionGroup | null>(null);
  // 待确认删除的会话（null = 没有待确认项）
  const [sessionToRemove, setSessionToRemove] =
    useState<SavedSession | null>(null);
  /**
   * 待确认导入的内容（null = 当前没有待确认的导入）。
   *
   * 解析结果先落在状态里、再让用户确认，是为了让「会导入几条、有几条
   * 重复」这些数字能在确认框里如实显示 —— 直接倒进去的话用户根本无从
   * 知晓会发生什么。
   */
  const [pendingImport, setPendingImport] =
    useState<ImportPreview | null>(null);
  // 新建会话时预选的分组
  const [newSessionGroup, setNewSessionGroup] =
    useState<string>("");
  /**
   * 弹窗「本次打开」的递增令牌。
   *
   * 会话/分组弹窗都用 useState 初始化表单，只在挂载时跑一次，而 key 里的
   * id 只在**编辑**时有值 —— 新建时 key 恒为 "new"，同一个 key 复用同一个
   * 组件实例，于是「打开→填一半→关掉→再打开」会带着上次的残留表单
   * （新建会话表现为落错分组，新建分组表现为残留上次输入的名字）。
   *
   * 令牌每次打开自增，key 就永远不同，必然重挂载。比在 key 里拼业务字段
   * 稳（那种写法要求每个字段都不能漏，且漏了就是静默 bug）。
   */
  const [dialogToken, setDialogToken] =
    useState(0);
  const [appReady, setAppReady] = useState(false);
  const [macroOpen, setMacroOpen] =
    useState(false);
  const [settingsOpen, setSettingsOpen] =
    useState(false);
  // 编辑中的宏；为 null 表示本次弹窗是「新增」
  const [editingMacro, setEditingMacro] =
    useState<TerminalMacro | null>(null);
  const appLoadingRef =
    useRef<AppLoadingHandle>(null);

  const macroStore = useMacros();

  const {
    sessions,
    query,
    setQuery,
    filteredSessions,
    save,
    update,
    addMany: addManySessions,
    remove,
    move,
    unassignGroup
  } = useSessions();

  const groupStore = useSessionGroups();
  const {
    groups,
    add: addGroup,
    addMany: addManyGroups,
    update: updateGroup,
    remove: removeGroup,
    toggle: toggleGroup
  } = groupStore;

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

  const terminals = useTerminals(
    // 已关闭/已断开的会话上迟到的 write/resize 只会得到这个错误，
    // 对用户毫无价值 —— 静默丢弃，其它错误照常展示
    reason => {
      const text = String(reason);
      if (text.includes("终端会话不存在")) return;
      setError(text);
    },
    (sourceSessionId, encrypted) => {
      const session = sessions.find(
        item => item.id === sourceSessionId
      );
      if (session)
        update({
          ...session,
          password: encrypted
        });
    },
    appSettings.settings,
    setTerminalFontSize
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
    dialogOpen ||
    macroOpen ||
    !!terminals.passwordRequest;
  useEffect(() => {
    if (!anyDialogOpen) refocusActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
  }, [anyDialogOpen]);

  function openCreate() {
    setEditingSession(null);
    // 会话弹窗里分组是必填项：侧栏标题栏的「+」没有分组上下文，
    // 预选第一个分组让常见路径只需填连接信息；一个分组都没有时才留空，
    // 由弹窗提示用户填。
    setNewSessionGroup(groups[0]?.id ?? "");
    setDialogToken(token => token + 1);
    setDialogOpen(true);
  }

  /**
   * 打开新建会话弹窗并预选目标分组。
   *
   * 侧栏分组标题行的「+」走这里 —— 用户已经用「点哪个分组的加号」
   * 表明了意图，再让他在弹窗里重选一遍是白填。
   */
  function openCreateInGroup(groupId: string) {
    setEditingSession(null);
    setNewSessionGroup(groupId);
    setDialogToken(token => token + 1);
    setDialogOpen(true);
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

  function openEdit(session: SavedSession) {
    setEditingSession(session);
    setDialogToken(token => token + 1);
    setDialogOpen(true);
  }

  function openCreateGroup() {
    setEditingGroup(null);
    setDialogToken(token => token + 1);
    setGroupDialogOpen(true);
  }

  function openEditGroup(group: SessionGroup) {
    setEditingGroup(group);
    setDialogToken(token => token + 1);
    setGroupDialogOpen(true);
  }

  /**
   * 保存会话。`pendingGroupName` 是弹窗分组框里手输、尚不存在的分组名。
   *
   * 先建组拿到 id 再挂会话 —— 顺序反了会话就指向空气；虽然 groupSessions
   * 会把它们兜进未分组节，但数据上是悬空引用，同名分组日后重建还会跳回去。
   */
  function saveSession(
    session: SavedSession,
    pendingGroupName: string
  ) {
    let groupId = session.groupId ?? "";
    if (pendingGroupName) {
      groupId = addGroup({
        name: pendingGroupName
      });
      console.debug(
        `[groups] 保存会话时顺带新建分组：${pendingGroupName}`
      );
    }
    const next = { ...session, groupId };
    if (editingSession) update(next);
    else save(next);
    setDialogOpen(false);
  }

  function saveGroup(group: SessionGroup) {
    if (editingGroup) {
      updateGroup(group.id, {
        name: group.name,
        color: group.color
      });
    } else {
      addGroup({
        name: group.name,
        color: group.color
      });
    }
    setGroupDialogOpen(false);
  }

  /**
   * 确认删除分组：把组内会话一并移回未分组。
   *
   * 只删分组不清理引用的话，那些会话的 groupId 会悬空；同名分组日后重建，
   * 它们会莫名跳回旧组。console 留痕，方便事后对账。
   */
  function confirmRemoveGroup() {
    if (!groupToRemove) return;
    const id = groupToRemove.id;
    unassignGroup(id);
    removeGroup(id);
    console.info(
      `[groups] 删除分组「${groupToRemove.name}」，组内会话已移回未分组`
    );
  }

  /**
   * 确认删除会话。
   *
   * 二次确认的价值：会话是用户逐条攒下来的连接信息，点错那个 × 就没了，
   * 且没有撤销入口。本机终端（id=local）不参与 —— 它是内置的、
   * 侧栏本来就不给删除按钮。
   */
  function confirmRemoveSession() {
    if (!sessionToRemove) return;
    remove(sessionToRemove.id);
    console.info(
      `[sessions] 删除会话「${sessionToRemove.name}」（${sessionToRemove.kind}）`
    );
  }

  /**
   * 把当前会话与分组导出到 JSON 文件。
   *
   * 本机终端不在导出范围内（见 buildExportPayload）。密码由后端那条
   * 「写文件」命令随内容一起落盘，所以这里传出去的 JSON 已经不含密码。
   */
  async function exportSessions() {
    if (sessions.length === 0) {
      setError(t("transfer.exportEmpty"));
      return;
    }
    try {
      const path = await invoke<string | null>(
        "export_to_file",
        {
          content: serializeExport(
            sessions,
            groups
          )
        }
      );
      // 用户取消保存框：后端返回 null，不是错误，静默收手
      if (!path) return;
      console.info(
        `[transfer] 导出 ${sessions.length} 个会话到 ${path}`
      );
      console.info(
        `[transfer] 导出完成：${sessions.length} 个会话`
      );
    } catch (reason) {
      console.error("导出会话失败", reason);
      setError(
        t("transfer.exportFailed", {
          error: String(reason)
        })
      );
    }
  }

  /**
   * 选文件 → 解析 → 停在确认框。
   *
   * 解析失败（选错文件、格式不对、版本过新）一律在这里就地提示，不弹框。
   * 传现有会话与分组：连接目标已存在的整条跳过，同名分组并入现有分组。
   * 全被跳过时不弹「导入 0 个会话」的确认框，直接提示后收手。
   */
  async function importSessions() {
    try {
      const raw = await invoke<string | null>(
        "import_from_file"
      );
      if (!raw) return;
      const result = parseImportPayload(
        raw,
        sessions,
        groups
      );
      if (!result.ok) {
        setError(
          t("transfer.importFailed", {
            error: result.error
          })
        );
        return;
      }
      // 整份文件里的会话都已在列表中：没什么可导的，
      // 弹确认框让用户点「导入」再看结果只会莫名其妙
      if (result.sessions.length === 0) {
        console.info(
          `[transfer] 导入中止：${result.skipped} 条会话均已存在`
        );
        setError(
          t("transfer.importNothingNew", {
            count: result.skipped
          })
        );
        return;
      }
      setPendingImport(result);
    } catch (reason) {
      console.error("读取会话文件失败", reason);
      setError(
        t("transfer.importFailed", {
          error: String(reason)
        })
      );
    }
  }

  /** 确认导入：分组与会话各一次写盘，顺序不能反 —— 会话要引用分组 id。 */
  function confirmImport() {
    if (!pendingImport) return;
    addManyGroups(pendingImport.groups);
    addManySessions(pendingImport.sessions);
    console.info(
      `[transfer] 导入 ${pendingImport.sessions.length} 个会话、新建 ${pendingImport.groups.length} 个分组（跳过已有 ${pendingImport.skipped} 条，${pendingImport.mergedGroups} 个同名分组并入现有分组）`
    );
    setPendingImport(null);
  }

  /** 打开本机终端：会话列表里固定的 local 会话，标题栏菜单与空状态共用。 */
  function openLocal() {
    const local = sessions.find(
      session => session.kind === "local"
    );
    if (local) terminals.open(local);
    else setError("未找到本机终端会话");
  }

  const loadingTimerRef =
    useRef<ReturnType<typeof setTimeout>>(
      undefined
    );

  useEffect(() => {
    const first = sessions[0];
    if (first) terminals.open(first);
    // 动效至少播放 5 秒：主界面渲染就绪后等待剩余时间，再淡出进入应用。
    loadingTimerRef.current = setTimeout(() => {
      appLoadingRef.current?.finish();
    }, 5000);
    return () =>
      clearTimeout(loadingTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLoadingFinished() {
    clearTimeout(loadingTimerRef.current);
    setAppReady(true);
  }

  // 菜单"复制"的可用性跟随终端选区：xterm 只发选区事件、没有可轮询的状态，
  // 用 useSyncExternalStore 订阅活动终端（订阅外部系统的标准做法，
  // 也避免在 effect 里同步 setState 造成的级联渲染）。
  const activeTerminal =
    terminals.active?.terminal;
  const subscribeSelection = useCallback(
    (onChange: () => void) => {
      if (!activeTerminal) return () => {};
      const disposable =
        activeTerminal.onSelectionChange(
          onChange
        );
      return () => disposable.dispose();
    },
    [activeTerminal]
  );
  const readSelection = useCallback(
    () =>
      Boolean(
        activeTerminal?.hasSelection() &&
        activeTerminal.getSelection().trim()
      ),
    [activeTerminal]
  );
  const hasSelection = useSyncExternalStore(
    subscribeSelection,
    readSelection
  );

  const menuState = useMemo(
    () => ({
      hasActive: Boolean(terminals.active),
      hasSelection,
      caseSensitive:
        terminals.searchCaseSensitive,
      regex: terminals.searchRegex
    }),
    [
      terminals.active,
      hasSelection,
      terminals.searchCaseSensitive,
      terminals.searchRegex
    ]
  );

  // 标题栏菜单动作：读写剪贴板失败统一走右下角错误提示
  const fail = (reason: unknown) =>
    setError(String(reason));
  const headerActions: HeaderActions = {
    newSession: openCreate,
    openLocal,
    closeActive: () => {
      if (terminals.active)
        terminals.close(terminals.active.id);
    },
    find: terminals.openSearch,
    toggleCaseSensitive:
      terminals.toggleCaseSensitive,
    toggleRegex: terminals.toggleRegex,
    copy: () => {
      const terminal = terminals.active?.terminal;
      if (!terminal?.hasSelection()) return;
      navigator.clipboard
        .writeText(terminal.getSelection())
        .catch(fail);
    },
    paste: () => {
      const terminal = terminals.active?.terminal;
      if (!terminal) return;
      navigator.clipboard
        .readText()
        .then(text => {
          if (text) terminal.paste(text);
        })
        .catch(fail);
    },
    selectAll: () =>
      terminals.active?.terminal.selectAll(),
    clear: () =>
      terminals.active?.terminal.clear(),
    devtools: () => {
      invoke("open_devtools").catch(fail);
    },
    openSftp: () => {
      const active = terminals.active;
      if (!active) {
        setError("请先打开一个会话");
        return;
      }
      // 传 sourceSessionId 而不是 id：复制出来的会话 id 是临时的
      // `dup-<原 id>-<时间戳>`，不落库，独立窗口按它取不到会话。
      // sourceSessionId 始终指向真正保存过的那个会话。
      // 每个 SFTP 会话开一个真正的系统窗口：会出现在任务栏里，
      // 可以并排摆放，也不会挡住主窗口里的终端
      invoke("open_sftp_window", {
        sessionId: active.sourceSessionId,
        title: active.name
      }).catch(fail);
    },
    openSettings: () => setSettingsOpen(true),
    exportSessions,
    importSessions,
    refocusTerminal: refocusActive
  };

  // 终端配色方案的背景/前景下传给 CSS：.terminal-host 的余数缝隙要跟
  // xterm 背景融为一体、划词覆盖层要用前景色做高亮 —— CSS 拿不到
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
          "--terminal-fg": scheme.foreground
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
          onEdit={openEdit}
          onRemove={setSessionToRemove}
          onCreate={openCreate}
          onToggleGroup={toggleGroup}
          onCreateGroup={openCreateGroup}
          onEditGroup={openEditGroup}
          onRemoveGroup={setGroupToRemove}
          onCreateInGroup={openCreateInGroup}
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
          onCreate={openCreate}
          onOpenLocal={openLocal}
          onSearch={terminals.search}
          onCloseSearch={terminals.closeSearch}
          onToggleCaseSensitive={
            terminals.toggleCaseSensitive
          }
          onToggleRegex={terminals.toggleRegex}
          macros={macroStore.macros}
          onRunMacro={runMacro}
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
      <SessionDialog
        // key 带上 dialogToken：每次打开都是新实例，表单按本次的
        // initialGroupId 重新初始化（否则新建时 key 恒为 "new"，
        // 组件被复用，上一次的分组/输入会残留下来）
        key={`${editingSession?.id ?? "new"}-${dialogToken}`}
        open={dialogOpen}
        session={editingSession}
        groups={groups}
        initialGroupId={newSessionGroup}
        onClose={() => setDialogOpen(false)}
        onSave={saveSession}
      />
      <GroupDialog
        key={`${editingGroup?.id ?? "new-group"}-${dialogToken}`}
        open={groupDialogOpen}
        group={editingGroup}
        onClose={() => setGroupDialogOpen(false)}
        onSave={saveGroup}
      />
      {groupToRemove && (
        <ConfirmDialog
          key={groupToRemove.id}
          eyebrow={t("group.remove")}
          title={t("group.removeTitle")}
          description={t(
            "group.removeDescription",
            { name: groupToRemove.name }
          )}
          confirmText={t("group.remove")}
          danger
          onConfirm={confirmRemoveGroup}
          onClose={() => setGroupToRemove(null)}
        />
      )}
      {sessionToRemove && (
        <ConfirmDialog
          key={sessionToRemove.id}
          eyebrow={t("session.remove")}
          title={t("session.removeTitle", {
            name: sessionToRemove.name
          })}
          description={t(
            "session.removeDescription"
          )}
          confirmText={t("session.remove")}
          danger
          onConfirm={confirmRemoveSession}
          onClose={() => setSessionToRemove(null)}
        />
      )}
      {pendingImport && (
        <ConfirmDialog
          // 一次性的令牌：连续导入两个文件时，内容变了但组件类型没变，
          // 不加 key 会复用上一次的实例
          key={
            pendingImport.sessions[0]?.id ??
            "import"
          }
          eyebrow={t("transfer.import")}
          title={t("transfer.importTitle", {
            sessions:
              pendingImport.sessions.length,
            groups: pendingImport.groups.length
          })}
          description={[
            t("transfer.importDescription"),
            pendingImport.mergedGroups > 0
              ? t("transfer.importMerged", {
                  count:
                    pendingImport.mergedGroups
                })
              : null,
            pendingImport.skipped > 0
              ? t("transfer.importSkipped", {
                  count: pendingImport.skipped
                })
              : null
          ]
            .filter(Boolean)
            .join(" ")}
          confirmText={t("transfer.import")}
          onConfirm={confirmImport}
          onClose={() => setPendingImport(null)}
        />
      )}
      {terminals.passwordRequest && (
        <PasswordDialog
          key={
            terminals.passwordRequest.session.id
          }
          session={
            terminals.passwordRequest.session
          }
          onSubmit={terminals.submitPassword}
          onCancel={terminals.cancelPassword}
        />
      )}
      {macroOpen && (
        <MacroDialog
          key={editingMacro?.id ?? "new"}
          macro={editingMacro}
          onSave={(name, command) => {
            if (editingMacro)
              macroStore.update(
                editingMacro.id,
                name,
                command
              );
            else macroStore.add(name, command);
          }}
          onClose={() => setMacroOpen(false)}
        />
      )}
      {error && (
        <Alert
          status="danger"
          className="app-toast"
          onClick={() => setError("")}
        >
          <Alert.Content>
            <Alert.Description>
              {error}
            </Alert.Description>
          </Alert.Content>
          {/* 真正可点的关闭钮：原来只是 ::after 画了个装饰性 ×，
              伪元素不接收事件，点了当然没反应 */}
          <button
            type="button"
            className="app-toast-close"
            aria-label={t("app.action.close")}
            onClick={event => {
              event.stopPropagation();
              setError("");
            }}
          >
            ×
          </button>
        </Alert>
      )}
      {!appReady && (
        <AppLoading
          ref={appLoadingRef}
          onFinished={handleLoadingFinished}
        />
      )}
    </main>
  );
}
