// 编译 app.scss 并与基准对比，确保拆 partial 后 CSS 输出逐字节一致。
// 用法：node scripts/check-scss-split.cjs <基准css路径>
const sass = require("sass");
const fs = require("fs");

const baseline = process.argv[2];
const out = sass.compile(
  "src/styles/app.scss"
).css;
const expected = fs.readFileSync(
  baseline,
  "utf8"
);
if (out === expected) {
  console.log("OK：CSS 输出与基准逐字节一致");
} else {
  fs.writeFileSync(baseline + ".actual", out);
  console.log(
    "DIFF：输出与基准不一致，实际输出已写到 " +
      baseline +
      ".actual"
  );
  process.exit(1);
}
