/**
 * 一次性脚本：域内按 tsx/ts 分成 components/ 与 lib/ 两个子文件夹。
 * 1. 扫描 src/ 各功能域，按扩展名分类；
 * 2. git mv 移动（保留历史）；
 * 3. 生成「域/文件名 → 域/子文件夹/文件名」映射，改写 src+tests 的全部引用
 *    （带右引号匹配，避免 @/sessions/session 误伤 @/sessions/sessionX）。
 * 跑完即删。
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  existsSync
} from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "src";
const SKIP = new Set([
  "assets",
  "styles",
  "node_modules",
  "target",
  ".git"
]);

// 1. 分类 + 生成移动计划与映射
//    支持断点续跑：上次已移进 components/lib 的文件不再移动，但仍要进映射
const plan = [];
const pathMap = new Map();
for (const entry of readdirSync(ROOT, {
  withFileTypes: true
})) {
  if (
    !entry.isDirectory() ||
    SKIP.has(entry.name)
  ) {
    continue;
  }
  const domain = entry.name;
  for (const f of readdirSync(
    join(ROOT, domain),
    { withFileTypes: true }
  )) {
    // 上次运行已移动到位的子目录：文件不重复移动，只补映射
    if (
      f.isDirectory() &&
      (f.name === "components" ||
        f.name === "lib")
    ) {
      for (const g of readdirSync(
        join(ROOT, domain, f.name)
      )) {
        const base = g.replace(/\.(tsx|ts)$/, "");
        pathMap.set(
          `${domain}/${base}`,
          `${domain}/${f.name}/${base}`
        );
      }
      continue;
    }
    if (!f.isFile()) continue;
    const base = f.name.replace(
      /\.(tsx|ts)$/,
      ""
    );
    if (f.name.endsWith(".tsx")) {
      plan.push({
        from: join(ROOT, domain, f.name),
        to: join(
          ROOT,
          domain,
          "components",
          f.name
        )
      });
      pathMap.set(
        `${domain}/${base}`,
        `${domain}/components/${base}`
      );
    } else if (f.name.endsWith(".ts")) {
      plan.push({
        from: join(ROOT, domain, f.name),
        to: join(ROOT, domain, "lib", f.name)
      });
      pathMap.set(
        `${domain}/${base}`,
        `${domain}/lib/${base}`
      );
    }
  }
}

// 2. git mv（先建目标目录；已存在则跳过）
for (const { from, to } of plan) {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) {
    console.log("skip (already there):", to);
    continue;
  }
  execFileSync("git", ["mv", from, to]);
  console.log("moved:", from, "->", to);
}

// 3. 改写引用
function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (
        [
          "node_modules",
          "target",
          ".git",
          "assets",
          "styles"
        ].includes(name)
      ) {
        continue;
      }
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

const PREFIXES = ["@/", "../src/"];
let rewritten = 0;
for (const file of [
  ...walk(ROOT),
  ...walk("tests")
]) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [key, value] of pathMap) {
    for (const prefix of PREFIXES) {
      after = after
        .split(`${prefix}${key}"`)
        .join(`${prefix}${value}"`);
    }
  }
  // main.tsx 在 src 根，用 "./" 相对导入
  if (file === join(ROOT, "main.tsx")) {
    for (const [key, value] of pathMap) {
      after = after
        .split(`./${key}"`)
        .join(`./${value}"`);
    }
  }
  if (after !== before) {
    writeFileSync(file, after);
    rewritten += 1;
    console.log("rewrote:", file);
  }
}
console.log(
  `moved ${plan.length} files, rewrote ${rewritten} files`
);
