/**
 * 终端的键盘输入管线：命令补全、`命令 /?` 快捷解释、vim 配色部署、
 * cat 代码高亮查看，以及普通的 PTY 写入。
 *
 * 从 useTerminals.ts 的 createTerminal 里拆出。三大拦截都走同一套
 * 「exec 通道 + 写本会话 pts」的回环：注入的内容作为终端**输出**进
 * ConPTY 缓冲，扛得住 vim 进出 / 面板切换 / resize 的整屏重绘；
 * stdin 走数据流分包，不受命令串 ~16KB channel request 上限。
 */
import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/sessions/lib/session";
import type { SshTarget } from "@/sessions/lib/sshTarget";
import { aiRunCommand } from "@/terminal/lib/ai/aiExec";
import { explainCommand } from "@/terminal/lib/ai/aiExplain";
import {
  highlightToAnsi,
  isVimCommand,
  parseCatCommand,
  VIM_SCHEME_SETUP
} from "@/terminal/lib/catView";
import { stripPrompt } from "@/terminal/lib/stripPrompt";
import type { ShellIntegration } from "@/terminal/lib/shellIntegration/shellIntegration";
import { attachCommandCompletion } from "@/terminal/lib/commandCompletion";
import {
  effectiveShortcuts,
  matchChord,
  parseChord
} from "@/shared/lib/appShortcuts";

/**
 * 事件是否命中某个「由终端层实现」的动作的**生效**键位。
 *
 * `find` / `devtools` 由终端层执行（AppHeader 的按键循环因
 * `handledElsewhere` 跳过它们，避免触发两遍），所以这是它们**唯一**
 * 的执行路径 —— 必须读 `effectiveShortcuts()` 而不是硬编码键位，
 * 否则用户在设置页改的键位不会生效。
 *
 * 用 `matchChord` 而不是 `matchAction`：后者是给 AppHeader 用的
 * （遍历整表找命中项），这里要的是「指定动作命中了吗」。
 */
export function matchTerminalShortcut(
  event: KeyboardEvent,
  actionId: "find" | "devtools"
): boolean {
  const chord = parseChord(
    effectiveShortcuts()[actionId] ?? ""
  );
  if (!chord) return false;
  return matchChord(event, chord);
}

/**
 * 给一只终端接上输入管线，返回补全实例（调用方还要用它处理
 * attachCustomKeyEventHandler 里的按键接管）。
 *
 * @param terminal 目标终端
 * @param session 会话定义（取连接信息与 id；exec 用的密码此时已是明文）
 * @param options.onError 错误上报（PTY 写入失败等）
 * @param options.commandCompletion 补全开关初值（设置改动由外部推送）
 * @param options.isDisconnected 会话是否已断开（断开后不再向后端写）
 */
export function attachTerminalInput(
  terminal: Terminal,
  session: SavedSession,
  options: {
    onError: (reason: unknown) => void;
    /** SFTP / AI 命令用的连接目标（启动时已解析跳板链与私钥） */
    execTarget: SshTarget;
    commandCompletion: boolean;
    isDisconnected: () => boolean;
    /**
     * 命令真正提交给远端时回调（长命令通知的计时起点）。
     *
     * 只在「放行给 PTY」的那条路径上触发 —— 见调用处的注释。
     */
    onCommandSubmitted?: (
      command: string
    ) => void;
    /**
     * shell 集成（OSC 133）：可用时输入起点与命令文本都由远端钩子给出，
     * 不再用 stripPrompt 猜提示符。见 terminal/lib/shellIntegration。
     */
    integration?: ShellIntegration;
  }
) {
  const {
    onError,
    execTarget,
    commandCompletion,
    isDisconnected,
    onCommandSubmitted,
    integration
  } = options;
  // 解释流程进行中吞掉键盘输入：期间终端坐标由流程接管，
  // 敲字会被远端回显进正在画的解释块里造成叠加
  let explaining = false;
  // cat 拦截查看进行中同样吞输入（exec 拉文件 + 高亮 + pts 注入期间）
  let viewing = false;
  // 命令补全（PSReadLine 内联预测风格）：ghost text 挂光标处，
  // → 整句接受、Ctrl+→ 按词接受；建议刷新由输出回显驱动
  const completion = attachCommandCompletion(
    terminal,
    {
      writeToPty: data => {
        invoke("terminal_write", {
          id: session.id,
          data,
          command: null
        }).catch(onError);
      },
      isInputBlocked: () =>
        isDisconnected() || explaining || viewing,
      enabled: commandCompletion,
      integration
    }
  );
  // pts 注入与 exec 共用：SSH 会话的 exec 目标 + 找该用户最新 pts 的
  // 脚本（cat 高亮、/? 解释、vim 改写都用这套回环）
  const ptsFind = `p=$(ps -u "$(whoami)" -o tty= --sort=start_time | grep pts | tail -1)`;
  terminal.onData(data => {
    // 会话断开后 PTY 可能已被移除，继续向后端写只会收到
    // "终端会话不存在"的错误气泡 —— 断连的终端敲键本就无意义。
    if (
      isDisconnected() ||
      explaining ||
      viewing
    ) {
      return;
    }
    let command: string | null = null;
    // 「本次按键是否提交了一条命令」——长命令计时的触发条件。
    // 独立于 command 是否取到文本（见文件末尾的注释）
    const isSubmit =
      data === "\r" ||
      data === "\n" ||
      data === "\r\n";
    if (isSubmit) {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(
        buffer.baseY + buffer.cursorY
      );
      // 命令文本三个来源（可靠性从高到低）：
      // - 已过 C 标记：直接用 C 那一刻抓到的命令行（含 Tab 补全展开）；
      // - 停在提示符处：从 B 标记的输入起点读到光标 —— 提示符长什么样
      //   都不影响，也不会把彩色/多行 PS1 啃掉一半；
      // - 没有集成：退回 stripPrompt（拿 `> $ #` 猜提示符结尾）。
      const inputText = integration?.available
        ? integration.atPrompt
          ? integration.readInput()
          : (integration.lastCommand() ?? "")
        : stripPrompt(
            line?.translateToString(true) ?? ""
          );
      command = inputText.trim()
        ? inputText
        : null;
      // 快捷命令解释：SSH 会话里「命令/?」回车 → 本地拦截 Enter、
      // Ctrl+U 清掉远端输入缓冲（不执行），解释攒完后从远端写进
      // 本会话的 pts —— 输出流经 ConPTY 进它自己的屏幕缓冲，
      // 天然抗 resize 整屏重绘；此前所有本地注入方案都会被抹掉
      const trimmed = command?.trim() ?? "";
      // 提示符原文（pts 注入的收尾要把它写回输入行）
      const rawLine =
        line?.translateToString(true) ?? "";
      const cut = rawLine.lastIndexOf(trimmed);
      const prompt =
        cut > 0 ? rawLine.slice(0, cut) : "";
      // 记录命令历史供补全建议（/? 解释不是要执行的命令，不入历史）。
      // 有 shell 集成时改在 C 标记处记录：那时的文本含 Tab 补全展开后的
      // 最终形态，比回车瞬间的缓冲区更准（见 terminalCreate 的接线）。
      if (
        command &&
        !trimmed.endsWith("/?") &&
        !integration?.available
      ) {
        completion.pushHistory(command);
      }
      if (
        session.kind === "ssh" &&
        trimmed.endsWith("/?")
      ) {
        const target = trimmed
          .slice(0, -2)
          .trim();
        if (target) {
          explaining = true;
          invoke("terminal_write", {
            id: session.id,
            data: "\x15",
            command: null
          }).catch(onError);
          // 回显+标题也从远端 pts 注入（sleep 0.5 让 Ctrl+U 的
          // 清行重绘先落地，否则会被 readline 重绘抹掉）；
          // 本地写不进 ConPTY 缓冲，resize 后会丢
          // ponytail: 取该用户最新启动的 pts shell；同一用户并发
          // 多个交互会话时可能写错窗口，需比对 SSH_CLIENT 端口
          aiRunCommand(
            execTarget,
            [
              ptsFind,
              `sleep 0.5`,
              `[ -n "$p" ] && cat > "/dev/$p" <<'AI_HEAD'`,
              trimmed,
              `\x1b[38;2;222;220;18m[AI正在分析: ${target}]\x1b[0m`,
              `AI_HEAD`
            ].join("\n")
          ).catch(reason =>
            console.warn(
              "[explain] pts 回显失败",
              reason
            )
          );
          let text = "";
          // 流式增量写入：解释 chunk 节流批量写进 pts，终端上呈打字机
          // 效果。写入经队列串行化，避免 exec 乱序导致文字错位；
          // 不再做逐行着色与裁宽 —— 半行没法裁，长行交给终端自动换行
          // ponytail: 若行宽错乱成为硬需求，需远端常驻进程按行回写
          let pending = "";
          let flushTimer: ReturnType<
            typeof setTimeout
          > | null = null;
          let started = false;
          // 队列只关心先后顺序，值丢弃，用 unknown 兜住 aiRunCommand 的返回
          let queue: Promise<unknown> =
            Promise.resolve();
          const flushPending = () => {
            flushTimer = null;
            if (!pending) return;
            const chunk = pending;
            pending = "";
            queue = queue.then(() =>
              aiRunCommand(
                execTarget,
                [
                  ptsFind,
                  `[ -n "$p" ] && printf '%s' '${chunk.replace(/'/g, `'\\''`)}' > "/dev/$p"`
                ].join("\n")
              ).catch(reason =>
                console.warn(
                  "[explain] pts 流式写入失败",
                  reason
                )
              )
            );
          };
          const pushChunk = (chunk: string) => {
            // 首批先落正文颜色码，之后整段持续同色
            pending += started
              ? chunk
              : `\x1b[38;2;27;186;233m${chunk}`;
            started = true;
            if (!flushTimer)
              flushTimer = setTimeout(
                flushPending,
                300
              );
          };

          void explainCommand(target, chunk => {
            text += chunk;
            pushChunk(chunk);
          })
            .catch(reason => {
              const message = `\n[解释失败] ${String(reason)}`;
              text += message;
              pushChunk(message);
            })
            .finally(() => {
              // 停掉节流器，把余量冲出去，再在队列尾补收尾：
              // 颜色复位（+补行尾换行）与提示符回写
              if (flushTimer)
                clearTimeout(flushTimer);
              flushPending();
              const tail = text.endsWith("\n")
                ? "\x1b[0m"
                : "\x1b[0m\n";
              const esc = prompt.replace(
                /'/g,
                `'\\''`
              );
              const escTail = tail.replace(
                /'/g,
                `'\\''`
              );
              queue = queue
                .then(() =>
                  aiRunCommand(
                    execTarget,
                    [
                      ptsFind,
                      `[ -n "$p" ] && printf '%s' '${escTail}' > "/dev/$p"`,
                      ...(prompt
                        ? [
                            `[ -n "$p" ] && printf '%s' '${esc}' > "/dev/$p"`
                          ]
                        : [])
                    ].join("\n")
                  )
                )
                .catch(reason =>
                  console.warn(
                    "[explain] pts 注入失败",
                    reason
                  )
                )
                .finally(() => {
                  explaining = false;
                  // 注入的提示符是纯文本、没有 A/B 标记，B 记下的输入
                  // 起点已经对不上光标了 —— 丢掉它，等远端下一次 B 重定位
                  integration?.reset();
                });
            });
        }
        return;
      }
      // vim/vi 查看代码：不改写用户的命令（命令行回显与远端 history
      // 保持原样），只确保 One Dark Pro 配色已部署到远端
      // ~/.vim/plugin 自动加载，然后原样放行回车。仅 SSH 会话
      // （本地 PowerShell 的 vim 是另一个世界）
      if (session.kind === "ssh") {
        if (isVimCommand(trimmed)) {
          aiRunCommand(
            execTarget,
            VIM_SCHEME_SETUP
          )
            .catch(reason =>
              console.warn(
                "[vim-view] 配色部署失败，vim 以默认配色打开",
                reason
              )
            )
            .finally(() => {
              invoke("terminal_write", {
                id: session.id,
                data: "\r",
                command: null
              }).catch(onError);
            });
          return;
        }
        // cat 查看代码：拦截单文件 cat，exec 拉内容 → cli-highlight 转
        // One Dark Pro ANSI → 经 exec 通道 stdin 写进本会话 pts
        // （`cat > /dev/$p`，与 /? 解释同一套回环）。写 pts 从动端是
        // 终端「输出」注入：回显行、代码、提示符全部进 ConPTY 缓冲，
        // 扛得住 vim 进出 / 面板切换 / resize 的整屏重绘；stdin 走数据
        // 流分包，不受命令串 ~16KB channel request 上限，一次往返出图。
        // 开头 Ctrl+U 清掉未执行的输入行（fetch 的往返时间正好让它的
        // readline 重绘先落地，无需 sleep），注入内容首行补回显 `cat 文件`。
        const catPath = parseCatCommand(trimmed);
        if (catPath) {
          viewing = true;
          const quoted = catPath.replace(
            /'/g,
            `'\\''`
          );
          const plain = `cat ${catPath}`;
          invoke("terminal_write", {
            id: session.id,
            data: "\x15",
            command: null
          }).catch(onError);
          const fallback = () =>
            invoke("terminal_write", {
              id: session.id,
              data: `${plain}\r`,
              command: plain
            }).catch(onError);
          aiRunCommand(
            execTarget,
            `cat -- '${quoted}'`
          )
            .then(result => {
              if (
                result.exitCode !== 0 ||
                !result.stdout
              ) {
                // 拉取失败：放行原命令让远端给出真实报错
                fallback();
                return undefined;
              }
              return highlightToAnsi(
                result.stdout,
                catPath
              ).then(code => {
                const body = code.endsWith("\n")
                  ? code
                  : `${code}\n`;
                return aiRunCommand(
                  execTarget,
                  [
                    ptsFind,
                    `[ -n "$p" ] && cat > "/dev/$p"`
                  ].join("\n"),
                  // 回显行 + 高亮代码 + 复位 + 提示符（readline 的
                  // 输入行已被 Ctrl+U 清空，提示符靠注入文本补画）
                  `${plain}\n${body}\x1b[0m\n${prompt}`
                );
              });
            })
            .catch(reason => {
              console.warn(
                "[cat-view] 拦截失败，回退原始命令",
                reason
              );
              fallback();
            })
            .finally(() => {
              viewing = false;
              // 同上：cat 拦截往屏幕上注入了代码与假提示符，
              // 输入起点已失效，等远端下一次 B 重新定位
              integration?.reset();
            });
          return;
        }
      }
    }
    // 真正交给远端执行的命令在此写出，此时开始计时长命令。
    //
    // ⚠️ 触发条件是「**按了回车**」，而不是「取到了命令文本」——这两件事
    // 必须分开：
    // 1) 按键先经 PTY 发给远端，远端回显之后命令才出现在 xterm 缓冲区。
    //    所以 onData 的这一瞬间 `buffer.getLine()` 很可能还是空的
    //    （stripPrompt 返回空 → command 为 null）。若拿 command 当条件，
    //    计时压根不会启动，长命令永远等不到通知。
    // 2) 也不能写成 `command ?? data` —— 普通按键时 command 恒为 null，
    //    兜底会把单个字符喂进来，变成**每敲一键就启动一次计时器**。
    //
    // 命令文本只用于通知正文，取不到就留空（正文退化成只显示耗时）。
    if (isSubmit && onCommandSubmitted)
      onCommandSubmitted(command ?? "");
    invoke("terminal_write", {
      id: session.id,
      data,
      command
    }).catch(onError);
  });
  return { completion };
}
