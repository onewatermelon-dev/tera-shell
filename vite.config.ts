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
