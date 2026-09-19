/**
 * 一次性脚本：目录扁平化后批量改写 import 路径。
 * 用 split/join 而不是正则，避免路径里的特殊字符被转义；跑完即删。
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync
} from "node:fs";
import { join } from "node:path";

const MAP = [
  ["@/features/", "@/"],
  ["@/app/components/", "@/app/"],
  ["@/shared/components/", "@/shared/"],
  ["../src/features/", "../src/"],
  ["../src/app/components/", "../src/app/"],
  ["../src/shared/components/", "../src/shared/"]
];

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (
        [
          "node_modules",
          "target",
          ".git"
        ].includes(name)
      )
        continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

const files = [...walk("src"), ...walk("tests")];
let changed = 0;
for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [from, to] of MAP) {
    after = after.split(from).join(to);
  }
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
    console.log("rewrote:", file);
  }
}
console.log(
  `total: ${files.length} files scanned, ${changed} rewritten`
);
