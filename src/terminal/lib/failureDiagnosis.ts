/**
 * 失败即诊断：把「命令 + 退出码 + 输出尾部」打包成一次可问 AI 的上下文。
 *
 * 与「值守」的区别：
 * - **事件驱动**：只在命令以非零退出码结束时发生一次，不常驻、不轮询；
 * - **不烧 token**：这里只负责**准备**文本，真正调 AI 要等用户点角上那个
 *   提示（见 FailureBadge → askAiFromTerminal）；
 * - 依赖 OSC 133 的 D 标记拿退出码（没有 shell 集成的会话拿不到，
 *   自然也不会提示）。
 *
 * 为什么只取输出尾部：命令输出可能有几万行，喂全量既费 token 也没用 ——
 * 报错基本都在末尾（stderr 与 traceback 的最后几帧）。
 */
import type { Terminal } from "@xterm/xterm";

/** 抓取失败现场时最多读多少行输出。 */
export const OUTPUT_TAIL_LINES = 40;

/** 一次命令失败。 */
export type TerminalFailure = {
  sessionId: string;
  /** 命令原文（OSC 133 的 C 标记读出来的，含 Tab 补全后的形态） */
  command: string;
  /** 非零退出码 */
  exitCode: number;
  /** 输出尾部（已去尾部空行） */
  output: string;
  /** 发生时间（毫秒时间戳） */
  at: number;
};

/**
 * 读终端缓冲区最后若干行的文本。
 *
 * @param terminal 目标终端
 * @param maxLines 最多读多少行
 */
export function readRecentOutput(
  terminal: Terminal,
  maxLines = OUTPUT_TAIL_LINES
): string {
  const buffer = terminal.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  // +1 是因为 end 这一行本身也要算进去（闭区间）
  const start = Math.max(0, end - maxLines + 1);
  const lines: string[] = [];
  for (let row = start; row <= end; row++) {
    const line = buffer.getLine(row);
    if (line)
      lines.push(line.translateToString(true));
  }
  // 去掉尾部空行：命令结束后 shell 通常会补空行
  while (
    lines.length > 0 &&
    lines[lines.length - 1]?.trim() === ""
  )
    lines.pop();
  return lines.join("\n");
}

/**
 * 拼成给 AI 的诊断正文。
 *
 * 明确标出「命令 / 退出码 / 输出」三段，模型不用猜哪句是命令、哪段是报错。
 *
 * @param failure 失败现场
 */
export function buildDiagnosisText(
  failure: TerminalFailure
): string {
  const head = [
    `命令 \`${failure.command}\` 执行失败，退出码 ${failure.exitCode}。`,
    "",
    "输出（末尾部分）："
  ].join("\n");
  const body = failure.output
    ? ["```", failure.output, "```"].join("\n")
    : "（没有捕获到输出）";
  return [
    head,
    body,
    "",
    "请判断失败原因并给出可直接执行的修复步骤；如果信息不足，说明还需要看什么。"
  ].join("\n");
}
