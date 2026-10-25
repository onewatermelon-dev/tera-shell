// 编译 MCP sidecar 二进制并按 tauri sidecar 命名放到 src-tauri/binaries/。
//
// tauri 的 externalBin（tauri.conf.json）只复制预先存在的 sidecar 文件，
// 不会替你编译。本脚本在 `pnpm tauri build` 前运行，产出：
//
//   src-tauri/binaries/tera-shell-mcp-<目标三元组>.exe
//
// 用法：`pnpm build:mcp`（或 `node scripts/build-mcp-sidecar.mjs`）。

import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync
} from "node:fs";
import {
  dirname,
  join,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(
  fileURLToPath(import.meta.url)
);
const srcTauri = resolve(
  __dirname,
  "..",
  "src-tauri"
);

// 1. 编译 release 版 MCP 二进制
console.log(
  "[mcp-sidecar] 编译 tera-shell-mcp (release) …"
);
execSync(
  "cargo build --release --bin tera-shell-mcp",
  {
    cwd: srcTauri,
    stdio: "inherit"
  }
);

// 2. 取目标三元组
const triple = execSync("rustc -vV", {
  encoding: "utf8"
})
  .split("\n")
  .find(line => line.startsWith("host: "))
  ?.replace("host: ", "")
  .trim();
if (!triple) {
  throw new Error("无法解析 rustc host 三元组");
}

// 3. 复制成 sidecar 命名
const ext =
  process.platform === "win32" ? ".exe" : "";
const built = join(
  srcTauri,
  "target",
  "release",
  `tera-shell-mcp${ext}`
);
if (!existsSync(built)) {
  throw new Error(`编译产物不存在：${built}`);
}
const binariesDir = join(srcTauri, "binaries");
mkdirSync(binariesDir, { recursive: true });
const sidecar = join(
  binariesDir,
  `tera-shell-mcp-${triple}${ext}`
);
copyFileSync(built, sidecar);
console.log(`[mcp-sidecar] 已生成：${sidecar}`);
