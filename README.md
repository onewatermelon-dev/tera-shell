# Tera Shell

> 基于 Tauri 2 + Vue 3 + xterm.js 的 Windows 桌面终端，把本地 PowerShell 与 SSH 连接整合进一个轻快的多标签工作区。

## 为什么值得一看

- **SSH 免密连接**：密码经 Windows DPAPI 加密后落盘，首次输入，之后双击会话直接连接，不再询问；凭据与当前 Windows 用户绑定，换机器无法解密。
- **真实多标签终端**：每个会话独立 PTY 进程、独立 xterm 实例，切换标签时移动 DOM 节点而非重建——滚动历史、光标位置、选区全部保留，同时开几十个会话也不掉状态。
- **标签溢出管理**：标签挤满标签栏时右侧自动出现"更多"下拉，滚轮横滑，任意一点裁切即触发，删标签即时收起，多会话场景下依然清爽。
- **终端内查找**：`Ctrl+F` 唤起浮层查找，支持正则与大小写切换，命中高亮实时更新，不打断终端输入焦点。
- **干净的选区体验**：自绘选区覆盖层只标记实际文字，杜绝 xterm 在"文字后面空白区域"上误选一整行。
- **无边框自绘窗口**：WebView2 浏览器级快捷键禁用后统一接管，开屏加载动效遮住启动白屏，观感一致。

## 技术栈

Tauri 2（Rust）· Vue 3（`<script setup>`）· TypeScript · xterm.js 6（WebGL / fit / search / unicode11）· portable-pty · Windows DPAPI · SCSS

## 项目结构

```
src/
  components/         # 视图组件（侧边栏、终端工作区、会话/密码弹窗、加载动效）
  composables/        # 业务逻辑（useSessions 会话持久化、useTerminals 终端生命周期）
  domain/             # 会话领域模型
  utils/              # 链接识别、文本选区覆盖层
src-tauri/
  src/
    terminal.rs       # PTY 会话表：启动 / 写入 / 缩放 / 关闭
    secret.rs         # DPAPI 加解密（SSH 密码）
    lib.rs            # 命令注册、WebView2 快捷键接管
tests/                # vitest 单元测试
```

## 未来路线图

- 顶部应用菜单（文件 / 编辑 / 查看 / 工具）落地为真实命令面板
- 设置中心：主题配色、字体 / 光标 / 启动行为
- 会话导入导出、分屏终端、重启恢复会话
- 标签拖拽排序、固定标签、标签右键菜单
- 可自定义快捷键与命令快速执行
- SSH 集成 SFTP 文件传输

## 本地开发

```bash
pnpm install
pnpm tauri dev        # 前端 Vite + 后端 Rust 热更新
pnpm build            # 类型检查 + 生产构建
pnpm tauri build      # 打包 exe / msi
pnpm test             # 单元测试
```

提交请使用 `pnpm commit`（commit-msg 钩子会拒绝直接 `git commit`）。

## 欢迎参与贡献

这个项目仍在早期，路线图上的每一项都欢迎认领，也欢迎你提出新的想法。规范要求：

- 代码风格跟随 ESLint / Prettier / Stylelint，注释使用中文
- 新功能请先开 issue 讨论再提 PR，避免方向性返工
- 测试放在根目录 `tests/`，改动涉及核心逻辑时补充用例

任何 PR，无论大小，都会认真 review。✨
