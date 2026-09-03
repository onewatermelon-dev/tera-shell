<script setup lang="ts">
import {
  Connection,
  Plus
} from "@element-plus/icons-vue";
import type { OpenSession } from "@/composables/useTerminals";

const terminalHost = defineModel<
  HTMLElement | undefined
>("terminalHost");

const props = defineProps<{
  opened: OpenSession[];
  active?: OpenSession;
  searchOpen: boolean;
  searchResult: { index: number; count: number };
  searchError: string;
  searchCaseSensitive: boolean;
  searchRegex: boolean;
}>();
const emit = defineEmits<{
  activate: [id: string];
  close: [id: string];
  create: [];
  search: [
    query: string,
    direction: "next" | "prev" | "input"
  ];
  closeSearch: [];
  toggleCaseSensitive: [];
  toggleRegex: [];
}>();

// 搜索框：本地输入词 + 打开时自动聚焦全选
const query = ref("");
const searchInput = ref<HTMLInputElement>();

// 切换大小写/正则后立即用当前词重搜
function toggleAndSearch(toggle: () => void) {
  toggle();
  emit("search", query.value, "input");
}
const searchCount = computed(
  () => props.searchResult.count
);
const searchIndex = computed(
  () => props.searchResult.index
);

watch(
  () => props.searchOpen,
  open => {
    if (!open) return;
    nextTick(() => {
      searchInput.value?.focus();
      searchInput.value?.select();
    });
  }
);
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
        <span class="status-dot"></span
        ><span>{{ tab.name }}</span
        ><i @click.stop="$emit('close', tab.id)"
          >×</i
        >
      </button>
      <button
        class="new-tab"
        title="新建会话"
        @click="$emit('create')"
      >
        <Plus />
      </button>
    </div>
    <div
      v-if="opened.length"
      :ref="
        element =>
          (terminalHost = element as HTMLElement)
      "
      class="terminal-host"
    ></div>
    <div v-else class="empty-terminal">
      <Connection />
      <h2>选择一个会话开始连接</h2>
      <p>
        从左侧打开本地终端，或新建一个 SSH 会话。
      </p>
      <button @click="$emit('create')">
        <Plus />
        新建会话
      </button>
    </div>
    <div class="terminal-status">
      <span>{{
        active?.kind === "ssh" ? "SSH" : "LOCAL"
      }}</span
      ><span>UTF-8</span
      ><span
        >{{ active?.terminal.cols || 0 }} ×
        {{ active?.terminal.rows || 0 }}</span
      >
    </div>
    <!-- 查找框：右上角浮层，支持正则，Enter 下一个 / Shift+Enter 上一个 -->
    <div v-if="searchOpen" class="find-box">
      <input
        ref="searchInput"
        v-model="query"
        class="find-input"
        placeholder="查找"
        @input="emit('search', query, 'input')"
        @keydown.enter.prevent="
          emit('search', query, 'next')
        "
        @keydown.shift.enter.prevent="
          emit('search', query, 'prev')
        "
        @keydown.esc="emit('closeSearch')"
      />
      <span class="find-count">
        <template v-if="searchError">{{
          searchError
        }}</template>
        <template v-else-if="searchCount">{{
          `${searchIndex + 1}/${searchCount}`
        }}</template>
        <template v-else-if="query"
          >无匹配</template
        >
      </span>
      <button
        class="find-btn"
        title="上一个 (Shift+Enter)"
        @click="emit('search', query, 'prev')"
      >
        ↑
      </button>
      <button
        class="find-btn"
        title="下一个 (Enter)"
        @click="emit('search', query, 'next')"
      >
        ↓
      </button>
      <button
        class="find-btn"
        :class="{ on: searchCaseSensitive }"
        title="区分大小写"
        @click="
          toggleAndSearch(() =>
            emit('toggleCaseSensitive')
          )
        "
      >
        Aa
      </button>
      <button
        class="find-btn"
        :class="{ on: searchRegex }"
        title="正则表达式"
        @click="
          toggleAndSearch(() =>
            emit('toggleRegex')
          )
        "
      >
        .*
      </button>
      <button
        class="find-btn"
        title="关闭 (Esc)"
        @click="emit('closeSearch')"
      >
        ×
      </button>
    </div>
  </section>
</template>
