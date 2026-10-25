//! 构建脚本。
//!
//! `tera-shell-mcp` 是 `src/bin/` 下的独立二进制，经 tauri 的
//! `externalBin`（见 tauri.conf.json）打进安装包。tauri 在编译期就校验
//! sidecar 文件存在（`binaries/tera-shell-mcp-<目标三元组>.exe`），所以
//! 该文件必须**提前存在**（占位即可，打包前由 `pnpm build:mcp` 用真实
//! 编译产物覆盖，见 scripts/build-mcp-sidecar.mjs）。
//!
//! ⚠️ 不要在 build.rs 里 `cargo build`：build 脚本调 cargo 会再次触发
//! build 脚本，形成死循环。sidecar 的编译交给 `beforeBuildCommand`
//! （`pnpm build && pnpm build:mcp`）在打包前完成。

fn main() {
	tauri_build::build()
}
