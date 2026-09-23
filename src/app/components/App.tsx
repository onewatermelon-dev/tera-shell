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
import { useTerminals } from "@/terminal/lib/useTerminals";
import { useT } from "@/settings/lib/i18n";
import type { SavedSession } from "@/sessions/lib/session";
import AppHeader, {
  type HeaderActions
} from "@/app/components/AppHeader";
import SessionSidebar from "@/sessions/components/SessionSidebar";
import TerminalWorkspace from "@/terminal/components/TerminalWorkspace";
import { useSettings } from "@/settings/lib/useSettings";
import SettingsPage from "@/settings/components/SettingsPage";
import { useMacros } from "@/terminal/lib/useMacros";
import MacroDialog from "@/terminal/components/MacroDialog";
import type { TerminalMacro } from "@/terminal/lib/terminalMacros";
import SessionDialog from "@/sessions/components/SessionDialog";
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
    remove
  } = useSessions();

  // 显示偏好：字体、字号、主题。必须早于 useTerminals —— 终端要用它建实例
  const appSettings = useSettings();

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
    appSettings.settings
  );

  function openCreate() {
    setEditingSession(null);
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
    setDialogOpen(true);
  }

  function saveSession(session: SavedSession) {
    if (editingSession) update(session);
    else save(session);
    setDialogOpen(false);
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
    openSettings: () => setSettingsOpen(true)
  };

  return (
    <main className="shell-app">
      <AppHeader
        actions={headerActions}
        menuState={menuState}
        hideMenus={settingsOpen}
      />
      <section className="workspace">
        <SessionSidebar
          sessions={filteredSessions}
          activeId={
            terminals.active?.sourceSessionId ??
            ""
          }
          openedCount={terminals.opened.length}
          query={query}
          onQueryChange={setQuery}
          onDuplicate={terminals.duplicate}
          onEdit={openEdit}
          onRemove={remove}
          onCreate={openCreate}
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
          onActivate={terminals.activate}
          onFocusTerminal={
            terminals.focusTerminal
          }
          onClose={terminals.close}
          onCloseTabs={terminals.closeMany}
          splitIds={terminals.splitIds}
          splitVisibleId={
            terminals.splitVisibleId
          }
          onActivateSplit={
            terminals.activateSplit
          }
          onSplitHost={terminals.setSplitHost}
          onSplit={terminals.split}
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
          onTerminalHost={
            terminals.setTerminalHost
          }
          macros={macroStore.macros}
          onRunMacro={runMacro}
          onAddMacro={() => {
            setEditingMacro(null);
            setMacroOpen(true);
          }}
          onEditMacro={macro => {
            setEditingMacro(macro);
            setMacroOpen(true);
          }}
          onDeleteMacro={macro =>
            macroStore.remove(macro.id)
          }
          onReorderMacro={macroStore.reorder}
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
        key={editingSession?.id ?? "new"}
        open={dialogOpen}
        session={editingSession}
        onClose={() => setDialogOpen(false)}
        onSave={saveSession}
      />
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
          className="toast"
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
            className="toast-close"
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
