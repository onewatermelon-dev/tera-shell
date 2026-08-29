import { computed, ref } from "vue";
import { localSession, type SavedSession } from "@/domain/session";

const storageKey = "tera-sessions";

function loadSessions(): SavedSession[] {
  try {
    const sessions = JSON.parse(localStorage.getItem(storageKey) || "null");
    return Array.isArray(sessions) && sessions.length ? sessions : [localSession];
  } catch {
    return [localSession];
  }
}

export function useSessions() {
  const sessions = ref(loadSessions());
  const query = ref("");
  const filteredSessions = computed(() => {
    const needle = query.value.toLowerCase();
    return sessions.value.filter(({ name, host }) => `${name}${host}`.toLowerCase().includes(needle));
  });

  function save(session: SavedSession) {
    sessions.value.push({ ...session, id: crypto.randomUUID() });
    persist();
  }

  function remove(id: string) {
    if (id === localSession.id) return;
    sessions.value = sessions.value.filter(session => session.id !== id);
    persist();
  }

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(sessions.value));
  }

  return { sessions, query, filteredSessions, save, remove };
}
