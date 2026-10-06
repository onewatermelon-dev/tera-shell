import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;
const root = import.meta.dirname;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": resolve(root, "src")
    }
  },
  build: {
    rollupOptions: {
      output: {
        // 全部依赖钉进一个共享 chunk：依赖只保留一份拷贝，
        // 避免按需分包把体积拆散（曾因 dist 陈旧产物堆积导致
        // exe 虚胖到 44MB，见 git 历史）
        manualChunks(id) {
          if (id.includes("node_modules")) {
            return "vendor";
          }
        }
      }
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
