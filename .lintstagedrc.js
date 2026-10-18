/**
 * 只检查和格式化本次已经暂存的文件。
 *
 * lint-staged 会在任务成功后自动把格式化结果重新加入暂存区，因此提交中保存的是
 * 格式化后的代码，而不是 git add 时的旧版本。下面的 glob 必须保持互斥，避免同一个
 * 文件被多个任务组并发修改，产生格式覆盖或工作区残留。
 *
 * ⚠️ Windows 坑（2026-10-13 踩到）：cmd.exe 命令行硬上限 8191 字符，而
 * lint-staged 内置的 maxArgLength 分片只按「命令串原长」估算，漏掉 tinyexec
 * 给每个参数追加的引号和 ^ 转义。127 个暂存文件原长 7864 被误判为放得下，
 * 实际拼出 8200+，cmd.exe 直接以「命令行太长」拒绝执行，prettier / eslint
 * 连进程都起不来（报 Task killed）。因此 JS/TS 组不依赖内置分片，按下面的
 * 预算主动切批；package.json 的 precommit 另加 --max-arg-length 兜底其余
 * 使用字符串命令的 glob。
 */

// 单条命令的长度预算：离 8191 上限留 2000+ 余量
const COMMAND_BUDGET = 6000;
// 每个文件路径的额外开销估算：2 个引号 + 1 个转义空格 + 余量
const PER_FILE_OVERHEAD = 6;

/**
 * 按预算把文件切成多批，保证每条命令拼出来后的实际长度
 * （含 tinyexec 追加的引号与 ^ 转义）仍低于 cmd.exe 上限。
 *
 * @param {string[]} files 文件路径（lint-staged 传入的是绝对路径）
 * @param {string} prefix 命令前缀，如 "prettier --write "
 * @returns {string[][]} 文件批次，每批对应一条命令
 */
const toBatches = (files, prefix) => {
  const batches = [];
  let batch = [];
  let length = prefix.length;
  for (const file of files) {
    const cost = file.length + PER_FILE_OVERHEAD;
    const tooLong =
      length + cost > COMMAND_BUDGET;
    if (batch.length > 0 && tooLong) {
      batches.push(batch);
      batch = [];
      length = prefix.length;
    }
    batch.push(file);
    length += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

/**
 * JS/TS 组任务：同 glob 内的命令按序执行，这里先跑完所有 prettier
 * 批次再跑所有 eslint 批次，确保 eslint 读到的都是格式化后的内容。
 *
 * @param {string[]} files 暂存的 JS/TS 文件
 * @returns {string[]} prettier / eslint 命令列表（可能多条）
 */
const jsTasks = files => {
  // 自动生成的 *.d.ts 不格式化也不检查（与 .prettierignore 保持一致）
  const sources = files.filter(
    file => !file.endsWith(".d.ts")
  );
  if (sources.length === 0) return [];
  return [
    ...toBatches(
      sources,
      "prettier --write "
    ).map(
      batch =>
        `prettier --write ${batch.join(" ")}`
    ),
    ...toBatches(sources, "eslint ").map(
      batch => `eslint ${batch.join(" ")}`
    )
  ];
};

export default {
  // JavaScript/TypeScript：先格式化，再执行代码规则检查。
  // 用函数过滤掉自动生成的 *.d.ts（与 .prettierignore 保持一致），
  // 返回的命令需自己拼好文件名——函数任务不会追加暂存文件。
  "*.{js,ts,cjs,mjs,tsx}": jsTasks,

  // 样式文件不交给 ESLint；Stylelint 在 Prettier 之后修复样式规则。
  "*.{css,scss}": [
    "prettier --write",
    "stylelint --fix"
  ],

  // 配置、模板和文档只需要格式检查。
  "*.{json,html,md}": ["prettier --write"]
};
