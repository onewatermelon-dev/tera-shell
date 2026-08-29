<script setup lang="ts">
import { Connection, Plus } from "@element-plus/icons-vue";
import type { OpenSession } from "@/composables/useTerminals";

defineProps<{ opened: OpenSession[]; active?: OpenSession }>();
defineEmits<{ activate: [id: string]; close: [id: string]; create: [] }>();
const terminalHost = defineModel<HTMLElement | undefined>("terminalHost");
</script>

<template>
  <section class="terminal-pane">
    <div class="tabs">
      <button
        v-for="tab in opened"
        :key="tab.id"
        class="tab"
        :class="{ active: active?.id === tab.id }"
        @click="$emit('activate', tab.id)"
      >
        <span class="status-dot"></span><span>{{ tab.name }}</span
        ><i @click.stop="$emit('close', tab.id)">×</i>
      </button>
      <button class="new-tab" title="新建会话" @click="$emit('create')">
        <Plus />
      </button>
    </div>
    <div v-if="opened.length" :ref="element => (terminalHost = element as HTMLElement)" class="terminal-host"></div>
    <div v-else class="empty-terminal">
      <Connection />
      <h2>选择一个会话开始连接</h2>
      <p>从左侧打开本地终端，或新建一个 SSH 会话。</p>
      <button @click="$emit('create')">
        <Plus />
        新建会话
      </button>
    </div>
    <div class="terminal-status">
      <span>{{ active?.kind === "ssh" ? "SSH" : "LOCAL" }}</span
      ><span>UTF-8</span><span>{{ active?.terminal.cols || 0 }} × {{ active?.terminal.rows || 0 }}</span>
    </div>
  </section>
</template>
