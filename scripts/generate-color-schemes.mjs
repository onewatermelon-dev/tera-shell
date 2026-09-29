// 一次性数据生成脚本：从 iTerm2-Color-Schemes 仓库（经 jsdelivr CDN）拉取
// 全部 Windows Terminal 格式的配色方案，转成 src/terminal/lib/colorSchemesData.ts。
//
// 用法：node scripts/generate-color-schemes.mjs
// 重新生成（同步上游新主题）时再跑；平时开发不需要。
//
// 数据键与 xterm.ITheme 的 ANSI 键对应：ansi 数组依次是
// black red green yellow blue magenta cyan white + bright 同序 8 色。

import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const CDN =
  "https://gh-proxy.com/https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/release-20260928-151043-99d9701/windowsterminal/";
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/terminal/lib/colorSchemesData.ts"
);

// 亮度判定：算背景的相对亮度，< 0.5 算深色（夜间模式分组用）
function isDark(bg) {
  const hex = bg.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (
    (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 <
    0.5
  );
}

async function fetchOne(name) {
  const url =
    CDN + encodeURIComponent(name) + ".json";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 走 curl 而不是 fetch：本机直连环境下 undici 常常握手失败，
      // curl 反而稳定；--fail 让 HTTP 错误也进 catch
      const { stdout } = await execFileAsync(
        "curl",
        [
          "-sL",
          "--fail",
          "--max-time",
          "30",
          url
        ],
        {
          maxBuffer: 1024 * 1024,
          encoding: "utf8"
        }
      );
      return JSON.parse(stdout);
    } catch (reason) {
      if (attempt === 2)
        throw new Error(`${name}: ${reason}`);
      await new Promise(resolve =>
        setTimeout(resolve, 500 * (attempt + 1))
      );
    }
  }
}

// 文件树：优先读命令行传入的本地缓存（data.jsdelivr 偶发抽风），否则现拉
import { readFileSync } from "node:fs";
let treeRaw;
const treeCache = process.argv[2];
if (treeCache) {
  treeRaw = readFileSync(treeCache, "utf8");
} else {
  ({ stdout: treeRaw } = await execFileAsync(
    "curl",
    [
      "-sL",
      "--fail",
      "--max-time",
      "60",
      "https://data.jsdelivr.com/v1/packages/gh/mbadolato/iTerm2-Color-Schemes@release-20260928-151043-99d9701?structure=flat"
    ],
    {
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8"
    }
  ));
}
const tree = JSON.parse(treeRaw);
const names = tree.files
  .filter(
    f =>
      f.name.startsWith("/windowsterminal/") &&
      f.name.endsWith(".json")
  )
  .map(f =>
    decodeURIComponent(
      f.name.slice(
        "/windowsterminal/".length,
        -".json".length
      )
    )
  );

console.log(`拉取 ${names.length} 个配色方案...`);
const schemes = [];
let done = 0;
// 并发 16，jsdelivr 对小文件限速宽松
const queue = [...names];
async function worker() {
  while (queue.length) {
    const name = queue.shift();
    const json = await fetchOne(name);
    const ansi = [
      json.black,
      json.red,
      json.green,
      json.yellow,
      json.blue,
      json.purple,
      json.cyan,
      json.white,
      json.brightBlack,
      json.brightRed,
      json.brightGreen,
      json.brightYellow,
      json.brightBlue,
      json.brightPurple,
      json.brightCyan,
      json.brightWhite
    ];
    if (ansi.some(v => typeof v !== "string")) {
      console.warn(`跳过（字段缺失）: ${name}`);
      continue;
    }
    schemes.push([
      json.name,
      isDark(json.background) ? 1 : 0,
      json.background,
      json.foreground,
      json.cursorColor || json.foreground,
      json.selectionBackground || "",
      ...ansi
    ]);
    done++;
    if (done % 50 === 0)
      console.log(`  ${done}/${names.length}`);
  }
}
await Promise.all(
  Array.from({ length: 8 }, worker)
);
schemes.sort((a, b) =>
  a[0].localeCompare(b[0], "en")
);

const body = JSON.stringify(schemes);
const ts = `// 自动生成：scripts/generate-color-schemes.mjs 从 mbadolato/iTerm2-Color-Schemes
// 拉取转换（勿手改）。每行：[名称, 1=深色, 背景, 前景, 光标, 选区(可空), ANSI×16]。
const RAW: [string, 0 | 1, string, string, string, string, ...string[]][] = ${body};

export default RAW;
`;
writeFileSync(OUT, ts);
console.log(
  `写入 ${OUT}（${schemes.length} 个方案）`
);
