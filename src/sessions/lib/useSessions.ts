import {
  useCallback,
  useMemo,
  useState
} from "react";
import {
  localSession,
  type SavedSession
} from "@/sessions/lib/session";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

function loadSessions(): SavedSession[] {
  try {
    const sessions = JSON.parse(
      readData(DataName.sessions) || "null"
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
 *
 * ⚠️ 本地终端是**例外**：`localSession` 是代码里的常量，从不写进 localStorage
 * （`loadSessions` 只在存储为空时才把它兜底返回）。少了这个特判，从本地终端
 * 打开 SFTP 窗口就会报"找不到这个会话"——而它本来只加载本地目录，是支持的。
 */
export function loadSession(
  id: string
): SavedSession | null {
  if (id === localSession.id) return localSession;
  try {
    const raw = readData(DataName.sessions);
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
      writeData(
        DataName.sessions,
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
