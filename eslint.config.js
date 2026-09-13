/**
 * ESLint 配置文件
 * 用于设置项目的代码规范和规则
 */
import { defineConfig } from "eslint/config"; // 从 eslint/config 中导入 defineConfig 函数
import eslint from "@eslint/js"; // 导入 eslint 的推荐配置
import tseslint from "typescript-eslint"; // 导入 TypeScript ESLint 配置
import eslintConfigPrettier from "eslint-config-prettier/flat"; // 导入 Prettier 的 ESLint 配置
import eslintPluginPrettier from "eslint-plugin-prettier"; // 导入 Prettier 插件
import reactHooks from "eslint-plugin-react-hooks"; // React Hooks 规则
import globals from "globals"; // 导入 全局变量配置

// 定义需要忽略的文件和目录
const ignores = [
  "**/node_modules/**",
  "**/dist/**",
  ".*",
  "scripts/**",
  "**/*.d.ts",
  "**/src-tauri/**"
];

// 导出 ESLint 配置
export default defineConfig(
  //通用配置
  {
    ignores, // 忽略的文件和目录
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      eslintConfigPrettier
    ], // 继承的配置
    plugins: {
      prettier: eslintPluginPrettier, // 添加 Prettier 插件
      "react-hooks": reactHooks // React Hooks 规则
    },
    languageOptions: {
      ecmaVersion: "latest", // 使用最新的 ECMAScript 版本
      sourceType: "module", // 使用 ES 模块
      parser: tseslint.parser, // 使用 TypeScript 解析器
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      //自定义规则
      "no-var": "error", // 禁止使用 var，使用 let/const 替代
      ...reactHooks.configs.recommended.rules, // React Hooks 推荐规则
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  //配置文件配置（Node.js 环境）
  {
    files: [
      "**/*.config.{js,cjs,ts}",
      "**/build/**/*.{js,ts}"
    ], // 配置文件
    languageOptions: {
      globals: {
        ...globals.node // Node.js 环境的全局变量
      }
    }
  }
);
