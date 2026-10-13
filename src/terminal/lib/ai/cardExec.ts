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
import { aiRunCommand } from "./aiExec";
import type { OpenSession } from "../session/terminalTypes";
import {
  parseWrappedOutput,
  trimToolOutput,
  type AiToolCall,
  type ExecCardMode
} from "./protocol";
import {
  commandInDirectory,
  directoryFromPrompt
} from "./tools";

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
 * @param mode terminal = 写进活动会话终端；background = 独立 exec 通道
 * @param skip true = 用户跳过，不执行直接回填占位结果
 * @param session 当前会话（background 模式取连接信息与提示符目录）
 * @param refresh 卡片状态变化后的重渲染回调（hook 里是 setEntries 刷新）
 */
export async function executeToolCard(
  call: AiToolCall,
  toolCallId: string,
  mode: ExecCardMode,
  skip: boolean,
  session: OpenSession | undefined,
  refresh: () => void
): Promise<string> {
  let content: string;
  if (skip) {
    call.state = "failed";
    call.error = "用户跳过了这条命令";
    content = "[用户跳过了这条命令，未执行]";
  } else if (mode === "terminal") {
    // 终端模式：命令写进活动会话的 PTY（同快捷宏路径），
    // 输出在终端里可见；稍后抓取缓冲区尾部作为工具结果回填
    call.state = "running";
    refresh();
    try {
      await invoke("terminal_write", {
        id: session?.id,
        data: `${call.command}\r`,
        command: call.command
      });
      session?.terminal.focus();
      // 固定 1.2 秒后抓缓冲区尾部：ponytail 简化 —— 慢命令拿到的只是
      // 中间输出，升级方向是监听输出静默期再抓
      await new Promise(resolve =>
        setTimeout(resolve, 1200)
      );
      const tail = terminalTail(
        session?.terminal,
        30
      );
      call.state = "done";
      call.stdout = trimToolOutput(tail);
      call.exitCode = -1;
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
      // 包装命令：先取主机名与当前目录，用于合成终端风格的提示符行，
      // 让执行结果与终端里看到的形态一致（含 `user@host:cwd# 命令`）
      const result = await aiRunCommand(
        {
          host: session?.host ?? "",
          port: session?.port,
          username: session?.username,
          password: session?.password
        },
        commandInDirectory(
          directory,
          `hostname; pwd; echo ---; ${call.command}`
        )
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
