<script setup lang="ts">
import TerminalWorkspace from "@/components/TerminalWorkspace.vue";
import PasswordDialog from "@/components/PasswordDialog.vue";
import { useSessions } from "@/composables/useSessions";
import { useTerminals } from "@/composables/useTerminals";
import type { SavedSession } from "@/domain/session";
import "@xterm/xterm/css/xterm.css";
import "@/styles/app.scss";

const dialogOpen = ref(false);
const error = ref("");
const editingSession = ref<SavedSession | null>(
  null
);
const {
  sessions,
  query,
  filteredSessions,
  save,
  update,
  remove
} = useSessions();
const terminals = useTerminals(
  reason => (error.value = String(reason)),
  // 首次连接输入的密码加密后写回对应会话，下次双击直接解密连接。
  (sourceSessionId, encrypted) => {
    const session = sessions.value.find(
      item => item.id === sourceSessionId
    );
    if (session)
      update({ ...session, password: encrypted });
  }
);

function openCreate() {
  editingSession.value = null;
  dialogOpen.value = true;
}

function openEdit(session: SavedSession) {
  editingSession.value = session;
  dialogOpen.value = true;
}

function saveSession(session: SavedSession) {
  if (editingSession.value) update(session);
  else save(session);
  dialogOpen.value = false;
}

onMounted(() => {
  const first = sessions.value[0];
  if (first) terminals.open(first);
});
</script>

<template>
  <main class="shell-app">
    <AppHeader />
    <section class="workspace">
      <SessionSidebar
        v-model:query="query"
        :sessions="filteredSessions"
        :active-id="
          terminals.active.value
            ?.sourceSessionId ?? ''
        "
        :opened-count="terminals.opened.length"
        @duplicate="terminals.duplicate"
        @edit="openEdit"
        @remove="remove"
        @create="openCreate"
      />
      <TerminalWorkspace
        v-model:terminal-host="
          terminals.terminalHost.value
        "
        :opened="terminals.opened"
        :active="terminals.active.value"
        :search-open="terminals.searchOpen.value"
        :search-result="
          terminals.searchResult.value
        "
        :search-error="
          terminals.searchError.value
        "
        :search-case-sensitive="
          terminals.searchCaseSensitive.value
        "
        :search-regex="
          terminals.searchRegex.value
        "
        @activate="terminals.activate"
        @close="terminals.close"
        @create="openCreate"
        @search="terminals.search"
        @close-search="terminals.closeSearch"
        @toggle-case-sensitive="
          terminals.toggleCaseSensitive
        "
        @toggle-regex="terminals.toggleRegex"
      />
    </section>
    <SessionDialog
      :open="dialogOpen"
      :session="editingSession"
      @close="dialogOpen = false"
      @save="saveSession"
    />
    <PasswordDialog
      v-if="terminals.passwordRequest.value"
      :session="
        terminals.passwordRequest.value.session
      "
      @submit="terminals.submitPassword"
      @cancel="terminals.cancelPassword"
    />
    <div
      v-if="error"
      class="toast"
      @click="error = ''"
    >
      {{ error }}
    </div>
  </main>
</template>
