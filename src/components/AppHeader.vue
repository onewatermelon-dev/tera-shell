<script setup lang="ts">
import {
  onBeforeUnmount,
  onMounted,
  ref
} from "vue";
import {
  Close,
  FullScreen,
  Minus,
  MoreFilled,
  Setting
} from "@element-plus/icons-vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 无框窗口：原生标题栏被移除，最小化/最大化/关闭由这里接管。
const appWindow = getCurrentWindow();
// 跟踪最大化状态，切换"最大化/还原"图标
const isMaximized = ref(false);
let unlistenResized: (() => void) | undefined;

onMounted(async () => {
  isMaximized.value =
    await appWindow.isMaximized();
  // 窗口尺寸变化（含双击标题栏、拖拽边缘缩放）时同步图标状态
  unlistenResized = await appWindow.onResized(
    async () => {
      isMaximized.value =
        await appWindow.isMaximized();
    }
  );
});

onBeforeUnmount(() => unlistenResized?.());
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>
      <span class="brand-mark">T</span
      ><strong>Tera Shell</strong>
    </div>
    <nav class="menu" aria-label="应用菜单">
      <button>文件</button>
      <button>编辑</button>
      <button>查看</button>
      <button>工具</button>
    </nav>
    <div class="title-actions">
      <button title="设置">
        <Setting />
      </button>
      <button title="更多">
        <MoreFilled />
      </button>
      <!-- 窗口控制三键：按 Windows 惯例排列，关闭键悬停标红 -->
      <div class="win-controls">
        <button
          class="win-btn"
          title="最小化"
          @click="appWindow.minimize()"
        >
          <Minus />
        </button>
        <button
          class="win-btn"
          :title="isMaximized ? '还原' : '最大化'"
          @click="appWindow.toggleMaximize()"
        >
          <FullScreen />
        </button>
        <button
          class="win-btn close"
          title="关闭"
          @click="appWindow.close()"
        >
          <Close />
        </button>
      </div>
    </div>
  </header>
</template>
