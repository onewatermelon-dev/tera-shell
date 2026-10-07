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
  normalizeColorTag,
  UNGROUPED_ID
} from "@/sessions/lib/sessionGroup";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";

/**
 * 读会话列表，并把每条补上分组/颜色的默认值。
 *
 * 旧数据没有这两个字段，统一补成空串（= 未分组、无颜色），
 * 免得下游到处判undefined。
 */
function loadSessions(): SavedSession[] {
  try {
    const sessions = JSON.parse(
      readData(DataName.sessions) || "null"
    );
    if (
      !Array.isArray(sessions) ||
      !sessions.length
    )
      return [localSession];
    return sessions.map((item: SavedSession) => ({
      ...item,
      groupId: item.groupId ?? UNGROUPED_ID,
      color: normalizeColorTag(item.color)
    }));
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
          {
            ...session,
            id: crypto.randomUUID(),
            groupId:
              session.groupId ?? UNGROUPED_ID,
            color: normalizeColorTag(
              session.color
            )
          }
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
        next[index] = {
          ...session,
          groupId:
            session.groupId ?? UNGROUPED_ID,
          color: normalizeColorTag(session.color)
        };
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

  /**
   * 拖拽落位：把 id 的会话移到 beforeId 之前，并归入 groupId 指定的分组。
   *
   * 两个动作合成一次写盘 —— 跨组拖拽时「改分组」和「换位置」必须同时生效，
   * 分两次 setSessions 会在中间态多落一次盘，拖拽频繁时白白多写。
   *
   * beforeId 为 null 表示追加到数组末尾（拖到列表下方空白处）。
   * 侧栏按分组分节渲染，组内顺序即数组顺序，所以单一数组就能表达分组 + 排序。
   */
  const move = useCallback(
    (
      id: string,
      groupId: string,
      beforeId: string | null
    ) => {
      setSessions(prev => {
        const from = prev.findIndex(
          item => item.id === id
        );
        if (from < 0) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        if (!moved) return prev;
        const to =
          beforeId === null
            ? next.length
            : next.findIndex(
                item => item.id === beforeId
              );
        if (to < 0) return prev;
        next.splice(to, 0, {
          ...moved,
          groupId
        });
        persist(next);
        return next;
      });
    },
    [persist]
  );

  /**
   * 批量把某个分组下的会话移回「未分组」。
   *
   * 删分组时必须一起调用：否则会话上的groupId 会指向已不存在的分组
   * （groupSessions 会把它们兜进未分组节，但原始数据里是悬空引用，
   * 同名分组重建后这些会话会莫名跳回去）。
   */
  const unassignGroup = useCallback(
    (groupId: string) => {
      setSessions(prev => {
        let changed = false;
        const next = prev.map(session => {
          if (session.groupId !== groupId)
            return session;
          changed = true;
          return {
            ...session,
            groupId: UNGROUPED_ID
          };
        });
        if (!changed) return prev;
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
    remove,
    move,
    unassignGroup
  };
}
