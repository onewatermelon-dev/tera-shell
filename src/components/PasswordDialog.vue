<script setup lang="ts">
import type { SavedSession } from "@/domain/session";

const props = defineProps<{
  session: SavedSession;
}>();
const emit = defineEmits<{
  submit: [password: string];
  cancel: [];
}>();

const password = ref("");
const input = ref<HTMLInputElement>();

watch(
  () => props.session,
  () => {
    password.value = "";
    nextTick(() => {
      input.value?.focus();
      input.value?.select();
    });
  },
  { immediate: true }
);

function submit() {
  if (!password.value) return;
  emit("submit", password.value);
}
</script>

<template>
  <div class="modal-backdrop">
    <form class="dialog" @submit.prevent="submit">
      <div class="dialog-head">
        <div>
          <span>SSH 认证</span>
          <h2>
            {{ session.username }}@{{
              session.host
            }}:{{ session.port }}
          </h2>
        </div>
        <button
          type="button"
          @click="emit('cancel')"
        >
          ×
        </button>
      </div>
      <label
        >密码<input
          ref="input"
          v-model="password"
          type="password"
          autocomplete="off"
          placeholder="输入密码，将加密保存在本机"
          @keydown.esc="emit('cancel')"
      /></label>
      <p class="hint">
        密码使用 Windows
        系统凭据加密后保存在本机，
        下次连接无需再次输入。
      </p>
      <div class="dialog-actions">
        <button
          type="button"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          class="connect-button"
          type="submit"
          :disabled="!password"
        >
          连接
        </button>
      </div>
    </form>
  </div>
</template>
