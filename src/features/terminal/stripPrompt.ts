/**
 * 从终端缓冲区的一行文本里剥出实际命令
 *
 * 终端行 = [提示符][命令]，常见提示符以 > (PowerShell)、$ (bash)、# (root)
 * 结束：取第一个后跟空白的这类标记，跳过其空白即命令起点。识别不到标记时
 * 返回空串，由调用方退回到输入流重建，避免把自定义提示符整行当做命令
 * @param line
 */
export function stripPrompt(
  line: string
): string {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ">" && c !== "$" && c !== "#")
      continue;
    const next = line[i + 1];
    if (
      next === undefined ||
      next === " " ||
      next === "\t"
    ) {
      let start = i + 1;
      while (
        start < line.length &&
        (line[start] === " " ||
          line[start] === "\t")
      ) {
        start++;
      }
      return line.slice(start).trimEnd();
    }
  }
  return "";
}
