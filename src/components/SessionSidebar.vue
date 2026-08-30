<script setup lang="ts">
import {
  Connection,
  Delete,
  FolderOpened,
  Plus,
  Search
} from "@element-plus/icons-vue";
import type { SavedSession } from "@/domain/session";

defineProps<{
  sessions: SavedSession[];
  activeId: string;
  openedCount: number;
}>();
const query = defineModel<string>("query", {
  required: true
});
defineEmits<{
  open: [session: SavedSession];
  remove: [id: string];
  create: [];
}>();
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <div>
        <span>会话</span
        ><small>{{ sessions.length }}</small>
      </div>
      <button
        class="icon-button primary"
        title="新建 SSH 会话"
        @click="$emit('create')"
      >
        <Plus />
      </button>
    </div>
    <label class="search-box">
      <Search />
      <input
        v-model="query"
        aria-label="搜索会话"
        placeholder="搜索会话"
    /></label>
    <div class="group-title">
      <span>我的会话</span>
      <FolderOpened />
    </div>
    <div class="session-list">
      <button
        v-for="session in sessions"
        :key="session.id"
        class="session-item"
        :class="{
          active: activeId === session.id
        }"
        @click="$emit('open', session)"
      >
        <span class="session-icon"
          ><Connection
        /></span>
        <span class="session-copy"
          ><strong>{{ session.name }}</strong
          ><small>{{
            session.kind === "local"
              ? "本机终端"
              : `${session.username ? session.username + "@" : ""}${session.host}:${session.port}`
          }}</small></span
        >
        <span
          v-if="session.id !== 'local'"
          class="delete"
          title="删除"
          @click.stop="
            $emit('remove', session.id)
          "
          ><Delete
        /></span>
      </button>
      <p
        v-if="!sessions.length"
        class="empty-list"
      >
        没有匹配的会话
      </p>
    </div>
    <div class="sidebar-foot">
      <span class="status-dot"></span
      ><span>就绪</span
      ><small>{{ openedCount }} 个连接</small>
    </div>
  </aside>
</template>
