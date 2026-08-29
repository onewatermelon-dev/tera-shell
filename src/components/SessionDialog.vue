<script setup lang="ts">
import { reactive, ref } from "vue";
import { Connection } from "@element-plus/icons-vue";
import { emptySshSession, type SavedSession } from "@/domain/session";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; save: [session: SavedSession] }>();
const form = reactive(emptySshSession());
const error = ref("");

function submit() {
  error.value = "";
  if (!form.name.trim() || !form.host.trim()) {
    error.value = "请填写会话名称和主机地址";
    return;
  }
  emit("save", { ...form });
  Object.assign(form, emptySshSession());
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @mousedown.self="$emit('close')">
    <form class="dialog" @submit.prevent="submit">
      <div class="dialog-head">
        <div>
          <span>新建连接</span>
          <h2>SSH 会话</h2>
        </div>
        <button type="button" @click="$emit('close')">×</button>
      </div>
      <label>会话名称<input v-model="form.name" autofocus placeholder="例如：生产服务器" /></label>
      <div class="form-row">
        <label class="grow">主机地址<input v-model="form.host" placeholder="192.168.1.10" /></label
        ><label>端口<input v-model.number="form.port" type="number" min="1" max="65535" /></label>
      </div>
      <label>用户名<input v-model="form.username" placeholder="root" /></label>
      <p class="hint">身份验证由系统 SSH 处理，支持已有密钥和 ssh-agent。</p>
      <p v-if="error" class="form-error">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" @click="$emit('close')">取消</button>
        <button class="connect-button" type="submit">
          <Connection />
          保存会话
        </button>
      </div>
    </form>
  </div>
</template>
