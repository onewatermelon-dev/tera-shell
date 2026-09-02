import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { playwright } from "@vitest/browser-playwright";
import { resolve } from "node:path";

export default defineConfig({
  // 与 vite.config.ts 保持一致的路径别名，tests/ 里 import "@/..." 才可用
  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  },
  test: {
    projects: [
      {
        test: {
          globals: true,
          name: "utils",
          include: [
            "tests/**/*.{test,spec}.{ts,js}"
          ],
          environment: "node"
        }
      },
      {
        plugins: [vue()],
        test: {
          globals: true,
          name: "ui",
          include: [
            "packages/components/__test__/**/*.{test,spec}.{ts,js,tsx,jsx}"
          ],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }]
          }
        }
      }
    ]
  }
});
