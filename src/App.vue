<script setup lang="ts">
import TerminalWorkspace from "@/components/TerminalWorkspace.vue";
import { useSessions } from "@/composables/useSessions";
import { useTerminals } from "@/composables/useTerminals";
import type { SavedSession } from "@/domain/session";
import "@xterm/xterm/css/xterm.css";
import "@/styles/app.scss";

const dialogOpen = ref(false);
const error = ref("");
const {
  sessions,
  query,
  filteredSessions,
  save,
  remove
} = useSessions();
const terminals = useTerminals(
  reason => (error.value = String(reason))
);

function saveSession(session: SavedSession) {
  save(session);
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
        :active-id="terminals.activeId.value"
        :opened-count="terminals.opened.length"
        @duplicate="terminals.duplicate"
        @remove="remove"
        @create="dialogOpen = true"
      />
      <TerminalWorkspace
        v-model:terminal-host="
          terminals.terminalHost.value
        "
        :opened="terminals.opened"
        :active="terminals.active.value"
        @activate="terminals.activate"
        @close="terminals.close"
        @create="dialogOpen = true"
      />
    </section>
    <SessionDialog
      :open="dialogOpen"
      @close="dialogOpen = false"
      @save="saveSession"
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
