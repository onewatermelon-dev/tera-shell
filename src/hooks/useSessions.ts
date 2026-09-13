import {
  useCallback,
  useMemo,
  useState
} from "react";
import {
  localSession,
  type SavedSession
} from "@/domain/session";

const storageKey = "tera-sessions";

function loadSessions(): SavedSession[] {
  try {
    const sessions = JSON.parse(
      localStorage.getItem(storageKey) || "null"
    );
    return Array.isArray(sessions) &&
      sessions.length
      ? sessions
      : [localSession];
  } catch {
    return [localSession];
  }
}

export function useSessions() {
  const [sessions, setSessions] =
    useState<SavedSession[]>(loadSessions);
  const [query, setQuery] = useState("");

  const persist = useCallback(
    (next: SavedSession[]) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify(next)
      );
    },
    []
  );

  const save = useCallback(
    (session: SavedSession) => {
      setSessions(prev => {
        const next = [
          ...prev,
          { ...session, id: crypto.randomUUID() }
        ];
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const update = useCallback(
    (session: SavedSession) => {
      setSessions(prev => {
        const index = prev.findIndex(
          item => item.id === session.id
        );
        if (index === -1) return prev;
        const next = [...prev];
        next[index] = { ...session };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const remove = useCallback(
    (id: string) => {
      if (id === localSession.id) return;
      setSessions(prev => {
        const next = prev.filter(
          session => session.id !== id
        );
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const filteredSessions = useMemo(() => {
    const needle = query.toLowerCase();
    return sessions.filter(({ name, host }) =>
      `${name}${host}`
        .toLowerCase()
        .includes(needle)
    );
  }, [sessions, query]);

  return {
    sessions,
    query,
    setQuery,
    filteredSessions,
    save,
    update,
    remove
  };
}
