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
          environment: "node",
          /**
           * 默认 5s 对本套件不够：有些用例会真的把 React 组件树渲染成
           * HTML（取色器那套HeroUI ColorPicker 连带 Select / ListBox /
           * ColorArea，首次 import 光Transform 就要好几秒），并发跑时
           * 更容易撞线。调到 20s —— 它只是放宽上限，不会让快用例变慢。
           */
          testTimeout: 20000
        }
      }
    ]
  }
});
