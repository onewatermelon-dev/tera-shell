import { describe, it, expect } from "vitest";
import { sanitizeToolNames } from "@/terminal/lib/ai/sanitize";
import { SYSTEM_PROMPT } from "@/terminal/lib/ai/promptContext";

/**
 * 回答里不能出现工具内部标识。
 *
 * ## 为什么提示词不够
 *
 * `SYSTEM_PROMPT` 里写了禁令，但那是「请求」不是「保证」——模型解释
 * 自己行为、或复述 schema 时很容易顺口带出 `run_command`。所以渲染前
 * 还要有一道定向替换兜底。
 *
 * ## 两条克制原则（改这个文件时别破坏）
 *
 * 1. **代码块内不动**：用户问「那个工具的 schema 长什么样」时，模型给
 *    的 JSON 示例里出现工具名是正确且必要的，无差别替换会把答案改错。
 * 2. **只认确切标识符**：`command`、`path` 这类普通词不能碰。
 */
describe("回答里抹掉工具标识", () => {
  it("正文里的工具名换成中文说法", () => {
    expect(
      sanitizeToolNames(
        "我会用 run_command 查一下这个进程"
      )
    ).toBe("我会用 命令执行 查一下这个进程");
    expect(
      sanitizeToolNames(
        "先调用 upload_local_file 把它传上去"
      )
    ).toBe("先调用 上传文件 把它传上去");
    expect(
      sanitizeToolNames(
        "通过 download_remote_file 取回"
      )
    ).toBe("通过 下载文件 取回");
  });

  it("反引号包裹的也要换（`run_command` 是模型最常见的写法）", () => {
    expect(
      sanitizeToolNames(
        "工具名是 `run_command` 这个"
      )
    ).toBe("工具名是 `命令执行` 这个");
    expect(
      sanitizeToolNames(
        "写成 **run_command** 就行"
      )
    ).toBe("写成 **命令执行** 就行");
  });

  it("后缀「工具 / tool」保持原样，不连句子的其余部分一起改", () => {
    // 只换标识符本身。`调用 命令执行 工具` 读着是有点怪，
    // 但把「工具」也吃掉会得到 `调用 命令执行` —— 后者改变了
    // 模型原本的句式，比前者更糟。真正的防线在 SYSTEM_PROMPT
    expect(
      sanitizeToolNames(
        "我将调用 run_command 工具执行"
      )
    ).toBe("我将调用 命令执行 工具执行");
    expect(
      sanitizeToolNames(
        "调用 upload_local_file tool"
      )
    ).toBe("调用 上传文件 tool");
  });

  it("一行里出现多次全部换掉", () => {
    expect(
      sanitizeToolNames(
        "run_command 跑命令，upload_local_file 传文件，download_remote_file 取文件"
      )
    ).toBe(
      "命令执行 跑命令，上传文件 传文件，下载文件 取文件"
    );
  });

  it("大小写混写也认（模型有时会写成 RUN_COMMAND）", () => {
    expect(
      sanitizeToolNames("用 RUN_COMMAND 执行")
    ).toBe("用 命令执行 执行");
  });

  it("围栏代码块内原样保留 —— schema 示例里出现是正确答案", () => {
    const text = [
      "这个工具叫 run_command，schema 如下：",
      "```json",
      '{"name": "run_command", "parameters": {}}',
      "```",
      "调用方式就是这样。"
    ].join("\n");
    const out = sanitizeToolNames(text);
    // 正文换了
    expect(out).toContain("这个工具叫 命令执行");
    // 块内的原文一个字都没动
    expect(out).toContain(
      '{"name": "run_command", "parameters": {}}'
    );
  });

  it("波浪号围栏同样识别", () => {
    const text = [
      "~~~",
      "run_command 在这里",
      "~~~"
    ].join("\n");
    expect(sanitizeToolNames(text)).toContain(
      "run_command 在这里"
    );
  });

  it("未闭合围栏内也不动（流式渲染中途就是这状态）", () => {
    // 流式输出时围栏还没闭合，若此时把块内内容替换掉，
    // 用户会看到代码块内容随着 token 到达而中途变字
    const text = [
      "说明文字 run_command 如下：",
      "```bash",
      "echo run_command 里的内容"
    ].join("\n");
    const out = sanitizeToolNames(text);
    expect(out).toContain(
      "说明文字 命令执行 如下："
    );
    expect(out).toContain(
      "echo run_command 里的内容"
    );
  });

  it("行内代码原样保留（用户问参数名时给的片段要准确）", () => {
    expect(
      sanitizeToolNames(
        "参数填 `remote_path` 就行"
      )
    ).toBe("参数填 `remote_path` 就行");
    // 一行内两个反引号对闭合 → 仍是行内代码，保护生效
    expect(
      sanitizeToolNames(
        "工具是 `run_command`，参数是 `command`"
      )
    ).toBe("工具是 `命令执行`，参数是 `command`");
  });

  it("普通词不误伤", () => {
    // command / path 这些在中文技术回答里也是普通名词，
    // 误伤比漏网更糟
    expect(
      sanitizeToolNames(
        "这个 command 会修改 path 下的文件"
      )
    ).toBe("这个 command 会修改 path 下的文件");
    expect(
      sanitizeToolNames(
        "npm run_command 不是命令"
      )
    ).toBe("npm 命令执行 不是命令");
  });

  it("空输入与无匹配原样返回", () => {
    expect(sanitizeToolNames("")).toBe("");
    expect(
      sanitizeToolNames("今天天气不错")
    ).toBe("今天天气不错");
  });

  it("保留 markdown 结构（换行 / 列表 / 标题）", () => {
    const text = [
      "## 用 run_command 排查",
      "",
      "1. 第一步",
      "2. 第二步"
    ].join("\n");
    const out = sanitizeToolNames(text);
    expect(out).toContain("## 用 命令执行 排查");
    expect(out).toContain("1. 第一步");
    // 空行也是一行：结构不能被替换动到
    expect(out.split("\n")).toHaveLength(4);
    expect(out.split("\n")[1]).toBe("");
  });

  it("标识符前后的空格保持不变（中文里那个空格是必要分隔）", () => {
    // ⚠️ 曾经把正则写成 `\s*name\s*`，结果「我用 run_command 查」
    // 变成「我用命令执行查」—— 空格被一起吃掉了
    expect(
      sanitizeToolNames("我用 run_command 查一下")
    ).toBe("我用 命令执行 查一下");
  });

  /**
   * plain 模式：思考过程与卡片说明是纯文本渲染（`<p>` / `<pre>`），
   * 没有「代码块」这回事。模型在思考里自己写的 ``` 只是分段习惯，
   * 走 markdown 保护反而会留下死角 —— 工具名从那里漏出去。
   */
  it("plain 模式：整篇替换，不留代码块死角", () => {
    const text = [
      "我要先看这段：",
      "```",
      "run_command 在这里也得换掉",
      "```",
      "然后调 download_remote_file"
    ].join("\n");
    const out = sanitizeToolNames(text, "plain");
    expect(out).toContain("命令执行");
    expect(out).toContain("下载文件");
    // plain 模式下不该有残留 —— 这正是它存在的意义
    expect(out).not.toContain("run_command");
    expect(out).not.toContain(
      "download_remote_file"
    );
  });

  it("plain 模式：markdown 的保护在这不生效（对比用例）", () => {
    const fenced = [
      "```",
      "run_command",
      "```"
    ].join("\n");
    // markdown 模式保护块内 → 保留
    expect(sanitizeToolNames(fenced)).toContain(
      "run_command"
    );
    // plain 模式不保护 → 换掉
    expect(
      sanitizeToolNames(fenced, "plain")
    ).not.toContain("run_command");
  });

  it("plain 模式：行内代码也不保护", () => {
    expect(
      sanitizeToolNames(
        "写 `run_command` 就行",
        "plain"
      )
    ).toBe("写 `命令执行` 就行");
  });

  it("plain 模式：结构与普通词仍保持", () => {
    expect(
      sanitizeToolNames(
        "这个 command 改了 path",
        "plain"
      )
    ).toBe("这个 command 改了 path");
    expect(sanitizeToolNames("", "plain")).toBe(
      ""
    );
  });

  it("思考块与流式思考都过了同一道替换", async () => {
    // 思考内容里复述工具名的概率比正文更高（那正是它在规划
    // 怎么调工具），用户点开折叠块看到的就是一串内部标识
    const block = (
      await import("@/terminal/components/ai/ReasoningBlock.tsx?raw")
    ).default;
    expect(block).toContain("sanitizeToolNames");
    // ⚠️ 必须是 plain：<p> 纯文本渲染，markdown 保护会留死角
    expect(block).toContain('"plain"');

    const list = (
      await import("@/terminal/components/ai/AiMessageList.tsx?raw")
    ).default;
    expect(list).toContain("sanitizeToolNames");
    // 流式 <pre> + 复制按钮的思考退路，两处都要 plain
    expect(
      (list.match(/"plain"/g) ?? []).length,
      "AiMessageList 里的 plain 调用少于两处"
    ).toBeGreaterThanOrEqual(2);
  });

  it("系统提示词把思考过程也划进禁写范围", () => {
    // 只禁正文不够 —— 思考内容同样原样展示给用户
    expect(SYSTEM_PROMPT).toContain("思考过程");
    expect(SYSTEM_PROMPT).toContain("reasoning");
    expect(SYSTEM_PROMPT).toContain("question");
  });

  it("渲染入口接上了（历史 + 流式两处都走 AiMarkdown）", async () => {
    const src = (
      await import("@/terminal/components/ai/AiMarkdown.tsx?raw")
    ).default;
    expect(src).toContain("sanitizeToolNames");
    // ⚠️ 顺序：`fillCodeFenceLanguage(sanitizeToolNames(text))` ——
    // sanitize 是**内层实参**，源码里出现在 fence 之后。反过来的话，
    // 行内代码里换出的中文可能被误判成围栏信息串。
    // 用 lastIndexOf 跳过 import 段（那里 fence 在 sanitize 之前）。
    const fenceAt = src.lastIndexOf(
      "fillCodeFenceLanguage("
    );
    const sanitizeAt = src.lastIndexOf(
      "sanitizeToolNames("
    );
    expect(fenceAt).toBeGreaterThan(-1);
    expect(sanitizeAt).toBeGreaterThan(fenceAt);
  });

  it("两张卡片的说明文字也过了同一道替换", async () => {
    for (const name of ["ToolCard", "FileCard"]) {
      const src = (
        await import(
          `@/terminal/components/ai/${name}.tsx?raw`
        )
      ).default;
      // question 由模型生成，是泄漏的另一入口
      expect(src).toContain("sanitizeToolNames");
    }
  });

  it("系统提示词明令禁止暴露工具名与参数名", () => {
    expect(SYSTEM_PROMPT).toContain(
      "绝不写进给用户的任何文本"
    );
    // 三个工具名本身要出现在提示词里（得告诉模型有哪些），
    // 但要配一条禁令
    for (const name of [
      "run_command",
      "upload_local_file",
      "download_remote_file"
    ]) {
      expect(SYSTEM_PROMPT).toContain(name);
    }
    // 参数名也是内部协议
    for (const param of [
      "remote_path",
      "is_read_only"
    ]) {
      expect(SYSTEM_PROMPT).toContain(param);
    }
    expect(SYSTEM_PROMPT).toContain(
      "只有用户主动问"
    );
  });
});

/**
 * 回答里不能出现客户端注入的上下文标签。
 *
 * 背景：`@` 引用把 `<terminal_screen>` 等快照块拼进用户消息后，模型
 * 复述内容时会顺口把标签也打出来（「我看到 `<terminal_screen>` 里第
 * 12 行…」）。与工具名同一套哲学：提示词禁令是请求，替换兜底是保证。
 *
 * 克制原则：**只剥标签本身，不动标签里的内容** —— 那是模型选择引用
 * 的日志，删了反而丢信息；代码块内不剥（与工具名同一保护规则）。
 */
describe("回答里抹掉客户端上下文标签", () => {
  it("剥掉 terminal_screen 开闭标签，内容保留", () => {
    const echoed =
      '我看到 <terminal_screen lines="24" note="用户正在看的终端屏幕（视口可见内容）">\nERROR at line 12\n</terminal_screen> 里第 12 行报错';
    expect(sanitizeToolNames(echoed)).toBe(
      "我看到 \nERROR at line 12\n 里第 12 行报错"
    );
  });

  it("三类终端标签与 current_workspace 都认", () => {
    for (const tag of [
      "terminal_screen",
      "terminal_scrollback",
      "terminal_selection",
      "current_workspace"
    ]) {
      // 只剥尖括号标签本身；裸词（不带尖括号）是普通文本，不动
      const text = `前 <${tag}> 内容 </${tag}> 后`;
      expect(sanitizeToolNames(text)).toBe(
        "前  内容  后"
      );
    }
  });

  it("反引号包裹的也剥（模型最常见的引用写法）", () => {
    expect(
      sanitizeToolNames(
        "标签是 `<terminal_screen>` 这个"
      )
    ).toBe("标签是 `` 这个");
  });

  it("大小写不敏感（模型可能改写成 Terminal_Screen）", () => {
    expect(
      sanitizeToolNames(
        "<Terminal_Screen>x</TERMINAL_SCREEN>"
      )
    ).toBe("x");
  });

  it("markdown 模式代码块内不剥（与工具名同一保护规则）", () => {
    const fenced =
      '```json\n{"block": "<terminal_screen>"}\n```';
    expect(sanitizeToolNames(fenced)).toBe(
      fenced
    );
  });

  it("plain 模式全剥（思考过程没有代码块概念）", () => {
    const fenced =
      "先看这段 ```\n<terminal_scrollback>\n```";
    expect(
      sanitizeToolNames(fenced, "plain")
    ).toBe("先看这段 ```\n\n```");
  });

  it("没有标签的文本原样返回", () => {
    const text =
      "今天 nginx 起来了，500 在 access.log 里";
    expect(sanitizeToolNames(text)).toBe(text);
  });

  it("系统提示词把上下文标签也划进禁写范围", () => {
    // 兜底之外，提示词里要先告诉模型这些符号的存在与禁令
    for (const tag of [
      "terminal_screen",
      "terminal_scrollback",
      "terminal_selection",
      "current_workspace"
    ]) {
      expect(SYSTEM_PROMPT).toContain(tag);
    }
    expect(SYSTEM_PROMPT).toContain(
      "绝不在自己的输出里原样写出这些标签"
    );
  });
});
