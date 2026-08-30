import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    AutoImport({
      imports: ["vue", "vue-router", "pinia"],
      resolvers: [ElementPlusResolver()],
      dts: "src/types/auto-imports.d.ts"
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: "src/types/components.d.ts"
    })
  ],

  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  },
  // 为 Tauri 开发量身定制的 Vite 选项，仅适用于 `tauri dev` 或 `tauri build`
  //
  // 1.防止Vite掩盖rust错误
  clearScreen: false,
  // 2. tauri 需要一个固定端口，如果该端口不可用则失败
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421
        }
      : undefined,
    watch: {
      // 3.告诉Vite忽略观看`src-tauri`
      ignored: ["**/src-tauri/**"]
    }
  }
}));
