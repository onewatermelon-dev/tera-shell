import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./app/components/App";
import SftpApp from "./sftp/components/SftpApp";
import { loadSettings } from "./settings/lib/settings";
import { setLocale } from "./settings/lib/i18n";
import { initStorage } from "./settings/lib/storage";

// 禁用 WebView2 默认右键菜单（含"检查"入口）；DevTools 仍可用 Ctrl+Shift+I 打开
document.addEventListener("contextmenu", e =>
  e.preventDefault()
);

// 同一个 index.html 服务两种窗口：
// 带 ?sftp=<会话 id> 的是后端的独立 SFTP 窗口，其余是主窗口。
const sftpSessionId = new URLSearchParams(
  window.location.search
).get("sftp");

/**
 * 启动流程：**先把数据读进内存，再渲染**。
 *
 * 数据存在磁盘文件上（见 storage.ts），而各处的 `loadXxx` 是同步的，
 * 所以必须等读完再挂载 —— 否则首帧会渲染成"一个会话都没有"的空状态，
 * 随后又要跳变一次。
 *
 * 语言也在这里定下来：等 useSettings 的 effect 再切会让首屏用错语言闪一下。
 */
async function bootstrap() {
  await initStorage();
  console.info("[boot] 应用数据已从磁盘加载");
  setLocale(loadSettings().locale);

  // 不用 StrictMode：开发模式下它会让 useEffect 双跑，导致挂载时的
  // terminals.open(first) 建出两个同 id 的后端 PTY，终端收到双份输出。
  createRoot(
    document.getElementById("app")!
  ).render(
    sftpSessionId ? (
      <SftpApp sessionId={sftpSessionId} />
    ) : (
      <App />
    )
  );

  // 窗口初始为隐藏（tauri.conf.json visible:false）以避免 webview 导航白屏；
  // 前端挂载完成、加载动画已渲染后再显示窗口，用户看到的是加载画面而非白屏。
  getCurrentWindow()
    .show()
    .catch(() => {});
}

void bootstrap();
