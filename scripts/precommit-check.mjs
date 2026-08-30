/**
 * pnpm commit 前置检查
 * 1. 暂存区为空且无变更时直接退出，避免填完提交信息才发现没有内容可提交
 * 2. 有未暂存文件时给出多选框，由人挑选要暂存哪些：
 *    ↑↓ 移动光标，空格 勾选/取消，a 全选/全不选，回车 确认
 */
import {
  execFileSync,
  spawn
} from "node:child_process";
import { emitKeypressEvents } from "node:readline";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8"
  }).trim();
}

let staged = [];
let unstaged = [];
try {
  staged = git([
    "diff",
    "--cached",
    "--name-only"
  ])
    .split("\n")
    .filter(Boolean);
  // 未暂存 = 已跟踪文件的改动（工作区 vs 暂存区）+ 未跟踪的新文件
  const modified = git(["diff", "--name-only"])
    .split("\n")
    .filter(Boolean);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard"
  ])
    .split("\n")
    .filter(Boolean);
  unstaged = [
    ...new Set([...modified, ...untracked])
  ];
} catch {
  console.error(
    "⚠️  无法读取 git 暂存区（当前目录不是 git 仓库？）"
  );
  process.exit(1);
}

if (!staged.length && !unstaged.length) {
  console.error(
    "\n⚠️  工作区没有任何变更，没有可提交的内容\n"
  );
  process.exit(1);
}

console.log(
  `\n✅ 已暂存 ${staged.length} 个文件：`
);
for (const file of staged)
  console.log(`   • ${file}`);

if (unstaged.length) {
  if (!process.stdin.isTTY) {
    // 非交互环境（管道/钩子）无法进行按键交互，只提示不阻塞
    console.log(
      `\n⚠️  未暂存 ${unstaged.length} 个文件（不会包含在本次提交中）：`
    );
    for (const file of unstaged)
      console.log(`   • ${file}`);
    launchCommitizen();
  } else {
    await pickUnstaged(unstaged);
    launchCommitizen();
  }
} else {
  launchCommitizen();
}

/** 多选框：↑↓ 移动、空格勾选、a 全选/全不选、回车确认 */
async function pickUnstaged(unstaged) {
  const checked = unstaged.map(() => false); // 每个文件的勾选状态
  let cursor = 0; // 光标所在行

  // 帧最后一行不带换行符（光标停在帧内），这样重绘按"上移 行数-1"计算，
  // 光标始终不会越过屏幕底边触发滚动，避免内容逐键上移错位
  const render = prevLines => {
    const lines = [
      `❓ 选择要暂存的文件（↑↓ 移动，空格 勾选，a 全选，回车 确认）：`,
      ...unstaged.map(
        (file, i) =>
          `${i === cursor ? "\x1b[36m❯\x1b[0m" : " "} [${checked[i] ? "\x1b[32mx\x1b[0m" : " "}] ${file}`
      )
    ];
    if (prevLines)
      process.stdout.write(
        `\x1b[${prevLines - 1}A\r\x1b[J`
      );
    else process.stdout.write("\n");
    process.stdout.write(lines.join("\n"));
    return lines.length;
  };

  let frameLines = render(0);
  const picked = [];

  // raw 模式逐键捕获；无论正常确认还是异常退出都要还原终端状态
  const stdin = process.stdin;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  const done = await new Promise(resolve => {
    const onKey = (_str, key) => {
      if (key.ctrl && key.name === "c") {
        process.stdout.write("\n"); // 让 shell 提示符回到行首
        resolve("abort");
        return;
      }
      if (key.name === "up" && cursor > 0)
        cursor--;
      else if (
        key.name === "down" &&
        cursor < unstaged.length - 1
      )
        cursor++;
      else if (key.name === "space")
        checked[cursor] = !checked[cursor];
      else if (key.name === "a") {
        const allChecked = checked.every(Boolean);
        checked.fill(!allChecked);
      } else if (key.name === "return") {
        unstaged.forEach(
          (file, i) =>
            checked[i] && picked.push(file)
        );
        resolve("confirm");
        return;
      } else {
        return; // 其他按键不重绘
      }
      frameLines = render(frameLines);
    };
    stdin.on("keypress", onKey);
  }).finally(() => {
    stdin.setRawMode(false);
    stdin.pause();
  });

  // 清掉整个交互框，留下干净的确认清单
  process.stdout.write(
    `\x1b[${frameLines - 1}A\r\x1b[J`
  );

  if (done === "abort") {
    console.log("\n⚠️  已取消提交\n");
    process.exit(1);
  }
  if (picked.length) {
    execFileSync(
      "git",
      ["add", "--", ...picked],
      { stdio: "inherit" }
    );
    console.log(
      `\n✅ 本次额外暂存 ${picked.length} 个文件：`
    );
    for (const file of picked)
      console.log(`   • ${file}`);
  } else {
    console.log("\n✅ 未暂存文件已跳过");
  }
}

// 所有分支（仅已暂存/挑选后/跳过）最终都从这里打开提交向导。
// 注入 CZ_GUARD 标记：husky 的 commit-msg 钩子据此放行，
// 环境变量沿 本脚本 → git-cz → git → 钩子 进程链自然继承，
// 绕过本脚本直接 git commit 时没有标记，会被钩子拒绝。
function launchCommitizen() {
  const child = spawn("git-cz", {
    stdio: "inherit",
    shell: true, // Windows 下解析 node_modules/.bin 里的 .cmd 需要 shell
    env: { ...process.env, CZ_GUARD: "1" }
  });
  child.on("close", code =>
    process.exit(code ?? 0)
  );
  child.on("error", err => {
    console.error(
      `\n❌ 无法启动 git-cz：${err.message}`
    );
    process.exit(1);
  });
}
