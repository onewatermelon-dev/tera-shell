import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";

// 禁用 WebView2 默认右键菜单（含"检查"入口）；DevTools 仍可用 Ctrl+Shift+I 打开
document.addEventListener("contextmenu", e =>
  e.preventDefault()
);

// 不用 StrictMode：开发模式下它会让 useEffect 双跑，导致挂载时的
// terminals.open(first) 建出两个同 id 的后端 PTY，终端收到双份输出。
createRoot(
  document.getElementById("app")!
).render(<App />);

// 窗口初始为隐藏（tauri.conf.json visible:false）以避免 webview 导航白屏；
// 前端挂载完成、加载动画已渲染后再显示窗口，用户看到的是加载画面而非白屏。
getCurrentWindow()
  .show()
  .catch(() => {});
