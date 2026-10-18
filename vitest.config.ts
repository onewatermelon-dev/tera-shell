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
           * HTML（取色器那套 HeroUI ColorPicker 连带 Select / ListBox /
           * ColorArea，首次 import 光 Transform 就要好几秒），并发跑时
           * 更容易撞线。
           *
           * 2026-10-18 从 20s 提到 40s：卡片经 Hint 拉进 HeroUI Tooltip
           * 后，整套依赖更重，54 个文件并发时三四个「首个 import」用例
           * 会稳定顶穿 20s（单独跑却全过）。它只是放宽上限，不会让快
           * 用例变慢；真 hang 仍然会在 40s 被抓住。
           */
          testTimeout: 40000
        }
      }
    ]
  }
});
