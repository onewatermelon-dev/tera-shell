/// <reference types="vite/client" />

declare module "*.css";
declare module "*.scss";

/**
 * 应用版本号：由 vite.config.ts 从 `src-tauri/tauri.conf.json` 注入
 * （构建期常量，不是运行时读取，测试环境里是 undefined —— 用到的地方
 * 要么有兜底，要么在组件里读，不要写进纯函数模块）。
 */
declare const __APP_VERSION__: string;
