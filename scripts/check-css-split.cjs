// 检查 CSS module 按给定行范围拆分后，是否存在「选择器引用了不在本文件的类」。
// 简化假设：声明行里不会出现 .class 形式的 token（var(--x) / 0.5px 均不匹配）。
const fs = require("fs");

const file = process.argv[2];
const spec = process.argv[3]; // "f1:1-343,375-492;f2:493-683;f3:344-374,684-955"

const lines = fs
  .readFileSync(file, "utf8")
  .split("\n");

const files = spec.split(";").map(part => {
  const [name, ranges] = part.split(":");
  const owned = new Set();
  for (const r of ranges.split(",")) {
    const [a, b] = r.split("-").map(Number);
    for (let i = a; i <= b; i++) owned.add(i);
  }
  return { name, owned };
});

function classTokens(line) {
  return (
    line.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []
  );
}

// 类名 -> 定义所在行集合（任何出现该 token 的行都算候选定义行）
const defLines = new Map();
lines.forEach((line, idx) => {
  for (const c of classTokens(line)) {
    if (!defLines.has(c))
      defLines.set(c, new Set());
    defLines.get(c).add(idx + 1);
  }
});

let problems = 0;
for (const f of files) {
  for (const n of f.owned) {
    const line = lines[n - 1];
    if (line === undefined) continue;
    if (line.trim().startsWith("/*")) continue;
    for (const c of classTokens(line)) {
      const defs = defLines.get(c) || new Set();
      const ok = [...defs].some(d =>
        f.owned.has(d)
      );
      if (!ok) {
        console.log(
          `[${f.name}] 第 ${n} 行：${line.trim().slice(0, 60)} → 引用 ${c} 不在本文件`
        );
        problems++;
      }
    }
  }
}
console.log(
  problems === 0
    ? "OK：无跨文件类引用"
    : `共 ${problems} 处问题`
);
