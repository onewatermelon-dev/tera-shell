/**
 * 执行卡片的落地逻辑：把模型给出的一条命令真正跑起来，并把结果
 * 截断为可回填给协议流的文本。
 *
 * 从 aiChat.ts 的 executeCard 拆出。两种执行方式：
 * - terminal：命令写进活动会话的 PTY，输出在终端里可见，稍后抓缓冲区尾部；
 * - background：走独立 exec 通道（aiExec），先 cd 到提示符目录，
 *   输出包上主机名与目录，合成终端风格的提示符行。
 *
 * 卡片状态（AiToolCall）由本函数就地修改，调用方通过 refresh 回调
 * 触发 React 重渲染。
 */
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import {
  logInfo,
  logWarn
} from "@/shared/lib/log";
import { aiRunCommand } from "./aiExec";
import { getEscalationPasswords } from "./escalation";
import { execTargetOf } from "@/sessions/lib/sshTarget";
import type { OpenSession } from "../session/terminalTypes";
import {
  parseWrappedOutput,
  trimToolOutput,
  type AiToolCall,
  type ExecCardMode
} from "./protocol";
import {
  commandInDirectory,
  directoryFromPrompt,
  userFromPrompt
} from "./tools";

/**
 * 终端里的用户是否已经不是连接账号（`su -` / `sudo -i`）。
 *
 * 后台 exec 通道是一条**独立的 ssh2 会话**，永远是登录账号 —— 它没法
 * 「在中间 su 一下」（su 要密码，而且那样会把密码写进命令）。所以终端里
 * 提过权之后，想让 AI 也用 root 跑，只能借用户手上这个已经是 root 的
 * shell，也就是写进 PTY。
 *
 * @param session 当前会话
 */
function suDetected(
  session: OpenSession | undefined
): boolean {
  if (!session || session.kind !== "ssh")
    return false;
  const promptUser = userFromPrompt(
    session.terminal
  );
  const loginUser = session.username;
  if (!promptUser || !loginUser) return false;
  return promptUser !== loginUser;
}

/**
 * 等终端里的命令跑完。
 *
 * 有 shell 集成时盯 `running / atPrompt`（C 之后、D 之前为 running），
 * 比固定 sleep 准得多 —— `apt install` 跑 30 秒也能等到真正结束。
 * 没有集成就退回固定 1.2 秒（拿到的可能只是中间输出，但至少不卡死）。
 *
 * @param session 当前会话
 * @param timeoutMs 上限，超时就按现有输出回填（不能让 AI 一直等）
 */
async function waitForCommandEnd(
  session: OpenSession | undefined,
  timeoutMs = 60_000
): Promise<void> {
  const integration = session?.integration;
  if (!integration?.available) {
    await new Promise(resolve =>
      setTimeout(resolve, 1200)
    );
    return;
  }
  const deadline = Date.now() + timeoutMs;
  // 先等它真的开始（写进 PTY 到 shell 执行之间有几十毫秒）
  while (
    Date.now() < deadline &&
    !integration.running
  ) {
    await new Promise(resolve =>
      setTimeout(resolve, 50)
    );
  }
  while (Date.now() < deadline) {
    if (
      !integration.running &&
      integration.atPrompt
    )
      return;
    await new Promise(resolve =>
      setTimeout(resolve, 150)
    );
  }
}

/** 读 xterm 缓冲区的最后 N 行（去掉尾部空行），用于收集终端执行的输出。 */
function terminalTail(
  terminal: Terminal | undefined,
  lines: number
): string {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  const out: string[] = [];
  const start = Math.max(
    0,
    buffer.length - lines
  );
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      out.push(line.translateToString(true));
    }
  }
  while (
    out.length &&
    !out[out.length - 1]?.trim()
  ) {
    out.pop();
  }
  return out.join("\n");
}

/**
 * 执行一张卡片并返回回填给协议流的 tool 消息内容。
 *
 * @param call 卡片（state / stdout / stderr / exitCode / error 就地修改）
 * @param toolCallId 协议流里配对的 tool_call_id
 * @param mode auto = 按终端身份自动选（su 过就走终端，拿到 root 权限）；
 *   terminal / background = 用户的显式选择，照办
 * @param skip true = 用户跳过，不执行直接回填占位结果
 * @param session 当前会话（background 模式取连接信息与提示符目录）
 * @param refresh 卡片状态变化后的重渲染回调（hook 里是 setEntries 刷新）
 * @param execId 后台执行的 id：带上它，停止时才能从后端掐掉这条命令
 *   （见 aiExec.cancelAiExec）
 */
export async function executeToolCard(
  call: AiToolCall,
  toolCallId: string,
  mode: ExecCardMode | "auto",
  skip: boolean,
  session: OpenSession | undefined,
  refresh: () => void,
  execId?: string
): Promise<string> {
  /**
   * 实际用哪条通道。
   *
   * - **auto**（模型自己决定 / 自动执行）：终端里 `su -` 过就写进终端 ——
   *   那条 shell 已经是 root，AI 的命令才会以 root 执行；后台通道是独立
   *   ssh2 会话，永远登录账号，提不了权。
   * - **显式选择**（用户点「后台执行」/「在终端执行」）：照用户说的办，
   *   不替他改（改过一次，被投诉"我点后台为什么终端也在跑"）。
   */
  const effectiveMode: ExecCardMode =
    mode === "auto"
      ? suDetected(session)
        ? "terminal"
        : "background"
      : mode;
  if (
    mode === "auto" &&
    effectiveMode === "terminal"
  )
    logInfo(
      "[ai] 终端已提权，本条改在终端执行以沿用该身份",
      call.command
    );

  let content: string;
  if (skip) {
    call.state = "failed";
    call.error = "用户跳过了这条命令";
    // 「不要重试」必须写明：只说"跳过了"模型会当瞬时失败，
    // 下一跳原样再发同一命令 —— 用户眼里就是跳过按钮"没生效"
    content =
      "[用户跳过了这条命令，未执行。用户已明确表示不想运行它，不要再次提议或重试同一命令；如任务无法继续，说明缺了这一步并询问如何调整。]";
  } else if (effectiveMode === "terminal") {
    // 终端模式：命令写进活动会话的 PTY（同快捷宏路径），
    // 输出在终端里可见；稍后抓取缓冲区尾部作为工具结果回填。
    call.state = "running";
    refresh();
    try {
      await invoke("terminal_write", {
        id: session?.id,
        data: `${call.command}\r`,
        command: call.command
      });
      session?.terminal.focus();
      await waitForCommandEnd(session);
      const tail = terminalTail(
        session?.terminal,
        30
      );
      call.state = "done";
      call.stdout = trimToolOutput(tail);
      call.exitCode = -1;
      // 让模型知道自己看到的是「终端尾部输出」而不是完整 stdout
      content = `[已在终端执行，以下为终端当前输出尾部]\n${call.stdout}`;
    } catch (reason) {
      call.state = "failed";
      call.error = String(reason);
      content = `[执行失败] ${String(reason)}`;
    }
  } else {
    call.state = "running";
    refresh();
    try {
      const directory = directoryFromPrompt(
        session?.terminal
      );
      if (!directory)
        throw new Error(
          "无法识别当前终端目录，请在终端提示符就绪后重试或选择终端执行"
        );
      // 身份差异只提示、不改行为：后台通道用的是登录账号，`su -` 之后
      // 权限和 `~` 的展开都和终端里看到的不一样
      const promptUser = userFromPrompt(
        session?.terminal
      );
      const identityMismatch =
        !!promptUser &&
        !!session?.username &&
        promptUser !== session.username;
      if (identityMismatch)
        logWarn(
          `[ai] 后台执行身份差异：终端是 ${promptUser}，通道是 ${session?.username}`,
          call.command
        );
      // 包装命令：先取主机名与当前目录，用于合成终端风格的提示符行，
      // 让执行结果与终端里看到的形态一致（含 `user@host:cwd# 命令`）
      // **模型自己判断**这条要不要 root：只有它把 escalate 设为 true，
      // 才带提权密码。全局配了密码也不能无脑提权 —— 每条命令都起一次
      // su 既慢又容易在无关命令上引入权限差异
      const escalate = call.escalate
        ? getEscalationPasswords(
            session?.id ?? ""
          )
        : undefined;
      if (
        escalate &&
        (escalate.sudoPassword ||
          escalate.suPassword)
      )
        logInfo(
          "[ai] 本条命令以提权方式执行",
          {
            sudo:
              escalate.sudoPassword.length > 0,
            su: escalate.suPassword.length > 0
          },
          call.command
        );
      const result = await aiRunCommand(
        execTargetOf(session),
        commandInDirectory(
          directory,
          `hostname; pwd; echo ---; ${call.command}`
        ),
        undefined,
        execId,
        escalate
      );
      // 通道执行完成即为 done：退出码非 0 是命令的正常输出
      // （如验证文件已删除的 ls、无匹配的 grep），由模型自行解读
      call.state = "done";
      call.stderr = result.stderr;
      call.exitCode = result.exitCode;
      const { hostName, cwd, output } =
        parseWrappedOutput(result.stdout);
      const promptLine = `${session?.username ?? "root"}@${hostName || session?.host || ""}:${cwd}# ${call.command}`;
      call.stdout = trimToolOutput(
        `${promptLine}\n${output}`
      );
      content = trimToolOutput(
        `退出码: ${result.exitCode}\n${promptLine}\n${output}${
          result.stderr
            ? `\n[stderr]\n${result.stderr}`
            : ""
        }${
          identityMismatch
            ? `\n[注意] 本条走后台通道，以 ${session?.username} 身份执行；终端当前是 ${promptUser}（su/sudo 切换过），权限与 ~ 的展开可能与预期不同`
            : ""
        }`
      );
    } catch (reason) {
      call.state = "failed";
      call.error = String(reason);
      content = `[执行失败] ${String(reason)}`;
    }
  }
  refresh();
  return content;
}
