<script setup lang="ts">
import { MoreFilled, Setting } from "@element-plus/icons-vue";
</script>

<template>
  <header class="titlebar">
    <div class="brand"><span class="brand-mark">T</span><strong>Tera Shell</strong></div>
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
    </div>
  </header>
</template>
