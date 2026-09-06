<script setup lang="ts">
/**
 * 应用启动加载层：WebView 初始化完成前渲染 MagicRings 动画遮住白屏，
 * 父组件在应用就绪后调用 finish() 触发淡出并销毁自身。
 */
import MagicRings from "./MagicRings.vue";

const fading = ref(false);
const emit = defineEmits<{
  finished: [];
}>();

function finish() {
  if (fading.value) return;
  fading.value = true;
  // 等淡出过渡结束再通知父组件移除加载层。
  setTimeout(() => emit("finished"), 500);
}

defineExpose({ finish });
</script>

<template>
  <div
    class="app-loading"
    :class="{ fading }"
    role="status"
    aria-label="正在加载"
  >
    <div class="app-loading-rings">
      <MagicRings
        color="#fc42ff"
        color-two="#42fcff"
        :ring-count="5"
        :speed="1"
        :attenuation="9"
        :line-thickness="2.5"
        :base-radius="0.3"
        :radius-step="0.11"
        :scale-rate="0.12"
        :opacity="0.95"
        :noise-amount="0.15"
      />
    </div>
    <p class="app-loading-text">
      TeraShell 启动中
    </p>
  </div>
</template>

<style scoped>
.app-loading {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0e14;
  opacity: 1;

  /* 就绪后整体淡出，避免动画戛然而止 */
  transition: opacity 0.5s ease;
}

.app-loading.fading {
  pointer-events: none;
  opacity: 0;
}

.app-loading-rings {
  position: absolute;
  inset: 0;
}

.app-loading-text {
  position: relative;
  z-index: 1;
  margin: 0;
  margin-top: 68vh;
  font-size: 13px;
  color: #8b949e;
  letter-spacing: 2px;
}
</style>
