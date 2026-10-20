/**
 * OSC 133（Shell Integration）序列体的解析。
 *
 * ## 协议
 *
 * 远端 shell 的钩子在几个固定时刻输出 `ESC ] 133 ; <体> BEL`：
 *
 * | 标记 | 时机 | 意义 |
 * |------|------|------|
 * | `A` | 提示符开始前 | 上一条命令的输出到此结束 |
 * | `B` | 提示符输出完 | 用户输入从光标处开始 |
 * | `C` | 命令开始执行 | 输入阶段结束，屏幕上就是完整命令行 |
 * | `D;exit=N` | 命令执行完 | 精确的结束点与退出码 |
 *
 * ## 为什么用 xterm 的 OSC handler 而不是自己扫字符串
 *
 * 自己扫输出流有两个绕不开的坑：
 *
 * 1. 序列会被 PTY 分块切断（半个 `ESC ] 133 ;`），得自己拼；
 * 2. 更要命的是**坐标对不上**：`B` 的含义是「此刻光标就是输入起点」，
 *    而事后扫描时缓冲区已经往后走了（同一块里 `B`+`C` 连着到时，
 *    命令行已经敲完，读到的位置就是行尾而不是起点）。
 *
 * `terminal.parser.registerOscHandler()` 在解析到该序列的**当下**回调，
 * 光标正好停在序列所在位置 —— 坐标天然正确，也不用拼块。这里只负责
 * 把序列体翻译成事件（纯函数，好测）。
 */

/** 一枚被识别出来的标记。 */
export type Osc133Event =
  | { kind: "prompt-start" }
  | { kind: "prompt-end" }
  | { kind: "command-start" }
  | {
      kind: "command-end";
      exitCode: number | null;
    };

/**
 * 从 `D` 的参数里取退出码：优先 `exit=N`，其次裸数字（部分实现的写法）。
 *
 * @param fields 分号切开后的参数（含首项 `D`）
 */
function readExitCode(
  fields: string[]
): number | null {
  for (const field of fields.slice(1)) {
    const value = field.startsWith("exit=")
      ? field.slice("exit=".length)
      : field;
    if (/^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * 解析 OSC 133 的序列体（`133;` 之后、终止符之前的部分）。
 *
 * 支持 `A`、`B`、`C`、`D`、`D;exit=1`、`D;1`。其它子命令（`P` 等扩展
 * 属性）一律忽略 —— 认不出来当没看见，比误判安全。
 *
 * @param body 序列体，如 `D;exit=130`
 */
export function parseOsc133Event(
  body: string
): Osc133Event | null {
  const fields = body.split(";");
  switch (fields[0]) {
    case "A":
      return { kind: "prompt-start" };
    case "B":
      return { kind: "prompt-end" };
    case "C":
      return { kind: "command-start" };
    case "D":
      return {
        kind: "command-end",
        exitCode: readExitCode(fields)
      };
    default:
      return null;
  }
}
