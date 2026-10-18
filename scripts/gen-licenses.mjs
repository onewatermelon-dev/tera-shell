/**
 * 生成「开源许可清单」数据：`src/settings/lib/licenses.generated.json`。
 *
 * 直接调 `pnpm licenses list --prod --json`：许可证识别（含 `MIT OR
 * Apache-2.0` 这类组合）交给 pnpm，比自己遍历 node_modules 猜字段靠谱 ——
 * 手写解析在 pnpm 的软链布局下会漏包（试过，150+ 个包只认出 17 个）。
 *
 * `--prod` 只算运行时依赖：vite / typescript / eslint 这些构建期包不会
 * 打进安装包，列在「本应用使用的开源组件」里只是噪音。
 *
 * 用法：`pnpm licenses`（改了依赖后重跑，产物随代码提交）。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const OUT = join(
  root,
  "src/settings/lib/licenses.generated.json"
);

let raw;
try {
  raw = execFileSync(
    process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm",
    ["licenses", "list", "--prod", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32"
    }
  );
} catch (reason) {
  console.error(
    "[licenses] 调用 pnpm 失败，先确认 pnpm 可用：",
    reason.message
  );
  process.exit(1);
}

/** { "MIT": [{ name, versions[] }], ... } → 扁平列表 */
function flatten(grouped) {
  const list = [];
  const seen = new Set();
  for (const [
    groupLicense,
    packages
  ] of Object.entries(grouped)) {
    for (const pkg of packages) {
      const versions = pkg.versions?.length
        ? pkg.versions
        : ["?"];
      for (const version of versions) {
        const key = `${pkg.name}@${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          name: pkg.name,
          version,
          // 包自己声明的优先，没有就用分组键（pnpm 按许可证分组的）
          license: pkg.license || groupLicense
        });
      }
    }
  }
  return list.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version)
  );
}

const list = flatten(JSON.parse(raw));
writeFileSync(
  OUT,
  `${JSON.stringify(list, null, 2)}\n`,
  "utf8"
);

const byLicense = new Map();
for (const item of list)
  byLicense.set(
    item.license,
    (byLicense.get(item.license) ?? 0) + 1
  );
const summary = [...byLicense.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(
    ([license, count]) => `${license}×${count}`
  )
  .join(", ");
console.log(
  `[licenses] ${list.length} 个包 → ${OUT}`
);
console.log(`[licenses] 分布：${summary}`);
