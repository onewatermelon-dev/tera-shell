/**
 * Runbook 库：命名命令序列（一条一行），可在当前会话按步执行。
 *
 * 与宏的差异：宏是「一条命令发进终端」，Runbook 是「多步命令走 exec
 * 通道逐条跑、汇总结果进 AI 对话」。支持 `{{名称}}` 占位符，执行前
 * 按提示填值（host/路径这类每次不同的东西）。
 */
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import { aiRunCommand } from "./aiExec";
import { logError } from "@/shared/lib/log";
import type { SshTarget } from "@/sessions/lib/sshTarget";

/** 单步输出保留尾部字符数：报错在尾部，横幅噪音在头部。 */
const STEP_OUTPUT_TAIL = 1200;

export type RunbookEntry = {
  id: string;
  title: string;
  /** 命令序列（一条一行；含 {{占位符}} 在执行前替换） */
  commands: string[];
  createdAt: number;
};

function loadAll(): RunbookEntry[] {
  try {
    const raw = readData(DataName.runbooks);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? (parsed as RunbookEntry[])
      : [];
  } catch {
    return [];
  }
}

/** 读全部 Runbook（新建的在前）。 */
export function loadRunbooks(): RunbookEntry[] {
  return loadAll();
}

/** 保存（存在同 id 则覆盖）。 */
export function saveRunbook(
  entry: RunbookEntry
): void {
  const all = loadAll();
  const at = all.findIndex(
    item => item.id === entry.id
  );
  if (at >= 0) all[at] = entry;
  else all.unshift(entry);
  writeData(
    DataName.runbooks,
    JSON.stringify(all)
  );
}

/** 删除一条。 */
export function deleteRunbook(id: string): void {
  writeData(
    DataName.runbooks,
    JSON.stringify(
      loadAll().filter(item => item.id !== id)
    )
  );
}

/** 提取命令序列里的全部占位符名（去重、按首次出现排序）。 */
export function extractPlaceholders(
  commands: string[]
): string[] {
  const names: string[] = [];
  for (const command of commands) {
    for (const match of command.matchAll(
      /\{\{\s*([\w.-]+)\s*\}\}/g
    )) {
      const name = match[1];
      if (name && !names.includes(name))
        names.push(name);
    }
  }
  return names;
}

/** 把 {{占位符}} 替换为输入值；未填的占位符原样保留（交由命令自己报错）。 */
export function applyPlaceholders(
  commands: string[],
  values: Record<string, string>
): string[] {
  return commands.map(command =>
    command.replace(
      /\{\{\s*([\w.-]+)\s*\}\}/g,
      (whole, name: string) =>
        values[name]?.trim()
          ? values[name].trim()
          : whole
    )
  );
}

/** 一步的执行结果。 */
export type RunbookStepResult = {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
  /** ok=false 时的失败原因（连接层错误而非命令报错） */
  error?: string;
};

/**
 * 在当前会话的 exec 通道按步执行命令序列。
 *
 * 单步失败**继续执行后续步骤**：运维脚本常有「清理步骤失败但整体
 * 还要往下走」，结果表里如实标注，归因交给 AI 汇总。
 *
 * @param onStep 已完成的步数（进 UI 显示 N/M）
 */
export async function runSteps(
  target: SshTarget,
  commands: string[],
  onStep?: (done: number, total: number) => void
): Promise<RunbookStepResult[]> {
  const results: RunbookStepResult[] = [];
  let done = 0;
  for (const command of commands) {
    try {
      const result = await aiRunCommand(
        target,
        command
      );
      const out = (
        result.stdout || result.stderr
      ).replace(/\s+/g, " ");
      results.push({
        command,
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        output:
          out.length > STEP_OUTPUT_TAIL
            ? `…${out.slice(-STEP_OUTPUT_TAIL)}`
            : out
      });
    } catch (reason) {
      logError(
        "[runbook] 步骤执行失败",
        command,
        reason
      );
      results.push({
        command,
        ok: false,
        exitCode: -1,
        output: "",
        error: String(reason)
      });
    }
    done += 1;
    onStep?.(done, commands.length);
  }
  return results;
}

/** 结果打包成发进对话的 markdown（模型续一轮汇总诊断）。 */
export function buildStepsMarkdown(
  title: string,
  results: RunbookStepResult[]
): string {
  const okCount = results.filter(
    item => item.ok
  ).length;
  const lines = [
    `已按 Runbook「${title}」执行 ${results.length} 步（成功 ${okCount} 步），请核对结果并汇总诊断异常步骤。`,
    "",
    "| # | 命令 | 状态 | 输出（尾部） |",
    "| --- | --- | --- | --- |"
  ];
  results.forEach((step, index) => {
    const status = step.ok
      ? "成功"
      : step.error
        ? `执行失败：${step.error}`
        : `退出码 ${step.exitCode}`;
    lines.push(
      `| ${index + 1} | \`${step.command.replace(/\|/g, "\\|")}\` | ${status} | ${step.output || "-"} |`
    );
  });
  return lines.join("\n");
}
