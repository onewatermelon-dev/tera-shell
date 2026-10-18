import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;
const root = import.meta.dirname;

/**
 * 应用版本号：**以 tauri.conf.json 为准**（安装包/更新器用的就是它）。
 * 构建时注入 `__APP_VERSION__`，前端不必为了读版本去申请 Tauri 权限，
 * 也不会出现 package.json 与安装包版本不一致的尴尬。
 */
const appVersion = JSON.parse(
  readFileSync(
    resolve(root, "src-tauri/tauri.conf.json"),
    "utf8"
  )
).version as string;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
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
