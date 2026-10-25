/**
 * 多机批量执行：对一批主机并发跑同一条命令，产出可发进 AI 对话的
 * 结果表格。并发天然来自后端 ExecPool（按 user@host:port 建池），
 * 这里只做编排：Promise.allSettled 保证单台失败不拖垮整批。
 *
 * 结果以 markdown 表格回填对话流，AI 续一轮即可汇总诊断 —— 不新造
 * 渲染组件，data-table / 表格卡原样生效。
 */
import { aiRunCommand } from "./aiExec";
import { isBlacklisted } from "./tools";
import type { SshTarget } from "@/sessions/lib/sshTarget";

/** 每台主机的输出保留尾部字符数：报错都在尾部，头部多是横幅噪音。 */
const OUTPUT_TAIL = 1200;

/** 参与批量执行的一台主机（连接目标已就绪）。 */
export type MultiExecHost = {
  id: string;
  name: string;
  target: SshTarget;
};

/** 一台主机的执行结果。 */
export type MultiExecResult = {
  id: string;
  name: string;
  /** true = 命令跑完拿到退出码；false = 连接/执行层失败 */
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** ok=false 时的失败原因 */
  error?: string;
};

/** 命令命中黑名单时返回提示文案，否则返回 null。 */
export function checkMultiExecBlacklist(
  command: string,
  blacklist: string[]
): string | null {
  return isBlacklisted(command, blacklist)
    ? "命令命中黑名单，已拒绝批量执行"
    : null;
}

/** 输出转单行表格单元格文本：压掉换行与过多空白，截尾部。 */
function cell(
  text: string,
  limit = OUTPUT_TAIL
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit
    ? `…${flat.slice(-limit)}`
    : flat;
}

/**
 * 并发在全部主机上执行同一条命令。
 *
 * @param onProgress 已完成的台数（进 UI 显示 N/M）
 */
export async function runOnHosts(
  hosts: MultiExecHost[],
  command: string,
  onProgress?: (
    done: number,
    total: number
  ) => void
): Promise<MultiExecResult[]> {
  let done = 0;
  const total = hosts.length;
  const settled = await Promise.allSettled(
    hosts.map(host =>
      aiRunCommand(host.target, command)
        .then(result => {
          done += 1;
          onProgress?.(done, total);
          return {
            id: host.id,
            name: host.name,
            ok: true,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            error: undefined
          } as MultiExecResult;
        })
        .catch(reason => {
          done += 1;
          onProgress?.(done, total);
          return {
            id: host.id,
            name: host.name,
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: "",
            error: String(reason)
          } as MultiExecResult;
        })
    )
  );
  // 每个元素都已被 catch 归一成结果，不会有 rejected
  return settled.map(
    item =>
      (
        item as PromiseFulfilledResult<MultiExecResult>
      ).value
  );
}

/**
 * 结果打包成发进对话的 markdown：表格 + 一句任务描述。
 * 模型收到后自然汇总（失败主机它会点名归因）。
 */
export function buildResultMarkdown(
  command: string,
  results: MultiExecResult[]
): string {
  const okCount = results.filter(
    item => item.ok && item.exitCode === 0
  ).length;
  const lines = [
    `已对 ${results.length} 台主机并发执行命令（成功 ${okCount} 台），请逐台核对结果并汇总诊断差异与失败原因。命令：`,
    "```bash",
    command,
    "```",
    "",
    "| 主机 | 状态 | 退出码 | 输出（尾部） |",
    "| --- | --- | --- | --- |"
  ];
  for (const item of results) {
    const status = !item.ok
      ? `执行失败：${cell(item.error ?? "", 200)}`
      : item.exitCode === 0
        ? "成功"
        : `退出码 ${item.exitCode}`;
    const out = cell(
      item.ok ? item.stdout || item.stderr : "",
      600
    );
    lines.push(
      `| ${item.name} | ${status} | ${item.ok ? item.exitCode : "-"} | ${out || "-"} |`
    );
  }
  return lines.join("\n");
}
