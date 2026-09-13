import {
  useEffect,
  useRef,
  useState
} from "react";
import { Alert } from "@heroui/react";
import { useSessions } from "@/hooks/useSessions";
import { useTerminals } from "@/hooks/useTerminals";
import type { SavedSession } from "@/domain/session";
import AppHeader from "@/components/AppHeader";
import SessionSidebar from "@/components/SessionSidebar";
import TerminalWorkspace from "@/components/TerminalWorkspace";
import SessionDialog from "@/components/SessionDialog";
import PasswordDialog from "@/components/PasswordDialog";
import AppLoading, {
  type AppLoadingHandle
} from "@/components/AppLoading";
import "@xterm/xterm/css/xterm.css";
import "@/styles/app.scss";
import "@/styles/main.css";

export default function App() {
  const [dialogOpen, setDialogOpen] =
    useState(false);
  const [error, setError] = useState("");
  const [editingSession, setEditingSession] =
    useState<SavedSession | null>(null);
  const [appReady, setAppReady] = useState(false);
  const appLoadingRef =
    useRef<AppLoadingHandle>(null);

  const {
    sessions,
    query,
    setQuery,
    filteredSessions,
    save,
    update,
    remove
  } = useSessions();

  const terminals = useTerminals(
    reason => setError(String(reason)),
    (sourceSessionId, encrypted) => {
      const session = sessions.find(
        item => item.id === sourceSessionId
      );
      if (session)
        update({
          ...session,
          password: encrypted
        });
    }
  );

  function openCreate() {
    setEditingSession(null);
    setDialogOpen(true);
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

  return (
    <main className="shell-app">
      <AppHeader />
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
          onClose={terminals.close}
          onCreate={openCreate}
          onSearch={terminals.search}
          onCloseSearch={terminals.closeSearch}
          onToggleCaseSensitive={
            terminals.toggleCaseSensitive
          }
          onToggleRegex={terminals.toggleRegex}
          onTerminalHost={
            terminals.setTerminalHost
          }
        />
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
