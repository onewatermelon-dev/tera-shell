/**
 * 文件改动卡片的读写通道（AI 面板专用）。
 *
 * 读：exec 通道 `cat`，输出即文件原文；写：`cat > 路径` 重定向，**内容走
 * stdin 数据流** —— 命令串本身只有路径，绕开 channel request 的 ~16KB
 * 包上限，大文件也能整篇写回（stdin 分包不受该限，见 aiExec 注释）。
 *
 * 两条都复用 ai_run_command：同一台服务器的命令在会话锁上天然串行，
 * 不存在「读和写交错」的半成品状态。
 */
import { aiRunCommand } from "./aiExec";
import {
  commandInDirectory,
  directoryFromPrompt,
  shellQuote
} from "./tools";
import type { OpenSession } from "../session/terminalTypes";

/** 读远端文件文本。失败 = 文件不存在 / 无权限 / 目录识别不了。 */
export async function readRemoteFileText(
  session: OpenSession | undefined,
  path: string
): Promise<string> {
  const directory = directoryFromPrompt(
    session?.terminal
  );
  if (!directory)
    throw new Error(
      "无法识别当前终端目录，请在终端提示符就绪后重试"
    );
  const result = await aiRunCommand(
    {
      host: session?.host ?? "",
      port: session?.port,
      username: session?.username,
      password: session?.password
    },
    commandInDirectory(
      directory,
      `cat -- ${shellQuote(path)}`
    )
  );
  if (result.exitCode !== 0)
    throw new Error(
      `读取失败：${result.stderr.trim() || `退出码 ${result.exitCode}`}`
    );
  return result.stdout;
}

/**
 * 写回远端文件。
 *
 * `cat >` 是截断重写：保留 inode 与权限（比 mv 覆盖安全，symlink 也
 * 跟着写进目标而不是替换链接本身）。
 */
export async function writeRemoteFileText(
  session: OpenSession | undefined,
  path: string,
  content: string
): Promise<void> {
  const directory = directoryFromPrompt(
    session?.terminal
  );
  if (!directory)
    throw new Error(
      "无法识别当前终端目录，请在终端提示符就绪后重试"
    );
  const result = await aiRunCommand(
    {
      host: session?.host ?? "",
      port: session?.port,
      username: session?.username,
      password: session?.password
    },
    commandInDirectory(
      directory,
      `cat > ${shellQuote(path)}`
    ),
    content
  );
  if (result.exitCode !== 0)
    throw new Error(
      `写入失败：${result.stderr.trim() || `退出码 ${result.exitCode}`}`
    );
}
