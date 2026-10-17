/**
 * 抹掉回答里泄漏的内部符号：工具标识符 + 客户端上下文标签。
 *
 * ## 为什么提示词还不够
 *
 * `SYSTEM_PROMPT` 已经明令禁止写工具名，但那是「请求」不是「保证」——
 * 模型在解释自己行为、或复述工具 schema 时很容易顺口带出
 * `run_command` / `remote_path` 这类标识符，用户看到的是一串毫无
 * 意义的英文。这里在渲染前做一道定向替换兜底。
 *
 * 上下文标签同理：`@` 引用把 `<terminal_screen>` 等快照块注入用户
 * 消息后，模型复述内容时会顺口把标签也打出来（「我看到
 * `<terminal_screen>` 里第 12 行…」）。只剥**标签本身**，不动标签里
 * 的内容 —— 那是模型选择引用的日志，删了反而丢信息。
 *
 * ## 两条克制原则
 *
 * 1. **代码块内不动**。用户问「你那个命令执行工具的 schema 长什么样」
 *    时，模型给出的 JSON 示例里出现工具名是**正确且必要**的；无差别
 *    替换会把答案改成错的。
 * 2. **只认确切标识符，不匹配普通词**。`command`、`path` 这类词在中文
 *    技术回答里也常作普通名词出现，误伤比漏网更糟。
 *
 * ## 替换只动标识符本身
 *
 * 不连前后空白、包裹符、后缀「工具」一起动 —— 那些是句子的其余部分，
 * 改了反而读着别扭（`调用 run_command 工具` → `调用 命令执行 工具`）。
 * 反引号包裹的情形自然保留（`` `run_command` `` → `` `命令执行` ``），
 * 因为替换只命中标识符本身，两侧的字符原封不动。
 */

/** 工具标识符 → 面向用户的中文说法。 */
const TOOL_LABELS: Record<string, string> = {
  run_command: "命令执行",
  upload_local_file: "上传文件",
  download_remote_file: "下载文件",
  propose_plan: "执行计划",
  ask_questions: "反问确认"
};

/** 依次要抹掉的标识符。 */
const TOOL_NAMES = Object.keys(TOOL_LABELS);

/**
 * 客户端注入用户消息的上下文标签（开标签可带属性）。
 *
 * terminal_* 三个是 `@` 引用终端内容的快照块（见 terminalRefs.ts），
 * current_workspace 是会话环境块（见 promptContext.ts）—— 同一类
 * 内部协议符号，模型复述时都会带出来。
 */
const CONTEXT_TAGS =
  /<\/?(?:terminal_(?:screen|scrollback|selection)|current_workspace)\b[^>]*>/gi;

/** 围栏起始行：与 fillCodeFenceLanguage 同一套判定（``` 或 ~~~）。 */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/**
 * 替换策略。
 *
 * - `markdown`（默认）：正文走 markdown 渲染，代码块内要保护 ——
 *   用户问「那个工具的 schema 长什么样」时，JSON 示例里出现工具名是
 *   正确且必要的，无差别替换会把答案改成错的。
 * - `plain`：思考过程与卡片说明是纯文本渲染（`<p>` / `<pre>`），
 *   不存在「代码块」这回事 —— 模型在那里写 ```json 只是它自己的
 *   分段习惯。再套代码块保护反而会留下死角：模型在思考里写
 *   「先看这段 ```\n run_command\n```」时，工具名就漏出去了。
 */
export type SanitizeMode = "markdown" | "plain";

/**
 * 把正文里的工具标识符换成中文说法。
 *
 * @param text 原始文本
 * @param mode `markdown` 保护代码块（默认）；`plain` 全量替换
 */
export function sanitizeToolNames(
  text: string,
  mode: SanitizeMode = "markdown"
): string {
  if (!text) return text;
  // 纯文本：没有代码块概念，直接整篇替换
  if (mode === "plain") {
    return stripContextTags(replaceNames(text));
  }
  let inFence = false;
  let fenceMarker = "";
  return text
    .split("\n")
    .map(line => {
      const fence = FENCE_LINE.exec(line);
      if (fence?.[1]) {
        const marker = fence[1][0] ?? "";
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
          fenceMarker = "";
        }
        // 围栏行本身原样返回
        return line;
      }
      if (inFence) return line;
      // 反引号个数为奇数 → 这行有段没闭合的行内代码，整体别动
      if (countTicks(line) % 2 === 1) return line;
      return stripContextTags(replaceNames(line));
    })
    .join("\n");
}

/**
 * 剥掉上下文标签本身，标签内的内容原样保留。
 *
 * 与工具名替换走同一条管线（同模式、同保护规则），所以复用时直接
 * 串在 replaceNames 之后 —— 顺序无所谓，两者命中不重叠。
 */
function stripContextTags(text: string): string {
  return text.replace(CONTEXT_TAGS, "");
}

/** 数一行里反引号的个数（连续三个按一个围栏记号算）。 */
function countTicks(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "`") continue;
    count += 1;
    if (line[i + 1] === "`") i += 1;
    if (line[i + 1] === "`") i += 1;
  }
  return count;
}

/**
 * 全量替换（不分行、不保护代码块）。
 *
 * ⚠️ **只匹配标识符本身**，不碰前后空白 / 包裹符 / 后缀「工具」——
 * 那些是句子的其余部分。也不加词边界：`run_command` 出现在
 * `npm run_command` 里照样要换（那也是模型在复述工具名）。
 */
function replaceNames(text: string): string {
  let out = text;
  for (const name of TOOL_NAMES) {
    const label = TOOL_LABELS[name] ?? name;
    out = out.replace(
      new RegExp(name, "gi"),
      label
    );
  }
  return out;
}
