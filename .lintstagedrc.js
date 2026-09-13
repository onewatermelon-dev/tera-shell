/**
 * 只检查和格式化本次已经暂存的文件。
 *
 * lint-staged 会在任务成功后自动把格式化结果重新加入暂存区，因此提交中保存的是
 * 格式化后的代码，而不是 git add 时的旧版本。下面的 glob 必须保持互斥，避免同一个
 * 文件被多个任务组并发修改，产生格式覆盖或工作区残留。
 */
export default {
  // JavaScript/TypeScript：依次检查拼写、格式，再执行代码规则检查。
  // 用函数过滤掉自动生成的 *.d.ts（与 .prettierignore 保持一致），
  // 返回的命令需自己拼好文件名——函数任务不会追加暂存文件。
  "*.{js,ts,cjs,mjs,tsx}": files => {
    const sources = files.filter(
      file => !file.endsWith(".d.ts")
    );
    return sources.length
      ? [
          `cspell lint ${sources.join(" ")}`,
          `prettier --write ${sources.join(" ")}`,
          `eslint ${sources.join(" ")}`
        ]
      : [];
  },

  // 样式文件不交给 ESLint；Stylelint 在 Prettier 之后修复样式规则。
  "*.{css,scss}": [
    "cspell lint",
    "prettier --write",
    "stylelint --fix"
  ],

  // 配置、模板和文档只需要拼写与格式检查。
  // cspell.json 的 ignorePaths 排除了 *.md 等文档，暂存 md 时会因为
  // “没有文件被实际检查”而让 cspell 以退出码 1 失败，故加 --no-must-find-files。
  "*.{json,html,md}": [
    "cspell lint --no-must-find-files",
    "prettier --write"
  ],

  // Rust 不由 Prettier 处理，目前只执行项目已有的拼写检查。
  "*.rs": ["cspell lint"]
};
