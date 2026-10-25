# binaries/

这里放 tauri 打包用的 **MCP sidecar 二进制**。

## 是什么

`tera-shell-mcp` 是 `src/bin/` 下的独立 Rust 二进制，让 Claude Code / Cursor
等外部 agent 通过 MCP 协议调用 tera-shell（列会话、执行命令等）。

它通过 `tauri.conf.json` 的 `bundle.externalBin` 打进安装包，安装后与主程序
`tera-shell.exe` 同目录。

## 为什么这个目录存在

tauri 2.x 的 `externalBin`（以及 `resources`）在 **build.rs 阶段**就校验被引用
的文件存在——即使 `cargo check`（debug）也会因缺 sidecar 报错：

```
resource path `binaries\tera-shell-mcp-x86_64-pc-windows-msvc.exe` doesn't exist
```

所以这个目录必须始终有一个 sidecar 文件（占位或真实产物）。

## 文件命名

sidecar 文件名必须是 `<base>-<目标三元组><扩展名>`，例如：

```
tera-shell-mcp-x86_64-pc-windows-msvc.exe
```

- `externalBin` 里写的是**不带三元组、不带扩展名**的 base 名
  （`binaries/tera-shell-mcp`）
- 目标三元组用 `rustc -vV | grep host` 查看

## 如何生成

`pnpm tauri build` 会自动跑 `beforeBuildCommand`（`pnpm build && pnpm build:mcp`），
其中 `pnpm build:mcp` 执行 `scripts/build-mcp-sidecar.mjs`，它负责：

1. `cargo build --release --bin tera-shell-mcp`
2. 把产物复制成 `tera-shell-mcp-<目标三元组>.exe` 放到本目录

开发时（只跑 `cargo check` / `cargo dev`，不走 `pnpm tauri build`）需要手动生成一次：

```bash
pnpm build:mcp
```

## 为什么 `.exe` 不进 git

本目录的 `*.exe` 被 `.gitignore` 忽略（见 `src-tauri/.gitignore`）——二进制不该
进版本库。但 tauri 编译期又要求文件存在，所以：

- 新 clone 的仓库里没有这个 `.exe`，第一次 `cargo check` 会报错
- 先跑一次 `pnpm build:mcp`（或 `pnpm tauri build`，它会自动生成）即可

> ⚠️ 不要在 build.rs 里 `cargo build` 来生成 sidecar：build 脚本调 cargo 会再次
> 触发 build 脚本，形成死循环。
