import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    projects: [
      {
        // 别名必须写在 project 里：projects 模式下不继承顶层 resolve.alias
        resolve: {
          alias: {
            "@": resolve(__dirname, "src")
          }
        },
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
