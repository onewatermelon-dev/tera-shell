import {
  useCallback,
  useMemo,
  useState
} from "react";
import {
  localSession,
  type SavedSession
} from "@/features/sessions/session";

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

/**
 * 按 id 取一个已保存的会话。
 *
 * 独立的 SFTP 窗口没有父级状态可继承，只能自己从本地存储里找 ——
 * 同一 origin 的多个窗口共用 localStorage，所以读得到主窗口存下的那份。
 */
export function loadSession(
  id: string
): SavedSession | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const list = JSON.parse(
      raw
    ) as SavedSession[];
    return (
      list.find(item => item.id === id) ?? null
    );
  } catch {
    return null;
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
