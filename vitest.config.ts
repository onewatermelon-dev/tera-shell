import { defineConfig } from "vitest/config";
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
      }
    ]
  }
});
