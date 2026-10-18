/**
 * AI 模型与工具调用的辅助函数：可选模型枚举、命令黑名单判定、
 * tool_call 参数解析、终端目录读取与命令包装。
 *
 * 从 aiChat.ts 拆出。除 listOpenAiModels 读设置外都是纯函数。
 */
import type { Terminal } from "@xterm/xterm";
import {
  loadProviders,
  type ModelEntry,
  type ModelProvider
} from "@/settings/lib/modelProviders";

/** 可选中的模型：供应商 × 模型。 */
export type AiModelOption = {
  providerId: string;
  modelId: string;
  /** 下拉展示文本：供应商 / 模型 */
  label: string;
  provider: ModelProvider;
  model: ModelEntry;
};

/** 列出可用的聊天模型：三种 API 格式都支持（面板下拉数据源）。 */
export function listOpenAiModels(): AiModelOption[] {
  return loadProviders()
    .filter(p => p.enabled)
    .flatMap(provider =>
      provider.models
        .filter(m => m.enabled && m.name.trim())
        .map(model => ({
          providerId: provider.id,
          modelId: model.id,
          label: `${provider.name} / ${model.name}`,
          provider,
          model
        }))
    );
}

/**
 * 这条命令能不能**自动执行**（不必弹确认卡）。
 *
 * 单一真源：runLoop 的主循环与「同批排队」的补跑都必须用同一个判断，
 * 否则两条路径对「只读/读写开关、黑名单」的理解会漂移 —— 出现过
 * 主循环守规矩、补跑却把读写命令直接跑掉的风险。
 *
 * 规则：黑名单一票否决；只读看「自动执行」，读写看「自动应用」。
 */
export function shouldAutoRun(
  call: { command: string; isReadOnly: boolean },
  options: {
    autoExecute: boolean;
    autoApply: boolean;
    blacklist: string[];
  }
): boolean {
  if (
    isBlacklisted(call.command, options.blacklist)
  )
    return false;
  return call.isReadOnly
    ? options.autoExecute
    : options.autoApply;
}

/**
 * 命令是否命中黑名单：扫描命令里**每一个**词的 basename（含 && ; | 管道
 * 拆出的后续命令与 sudo/env 前缀后的真命令）比对黑名单——复合命令
 * （`cd /root && rm -rf x`、`sh -c "rm ..."`）只看首词必然漏检。
 */
export function isBlacklisted(
  command: string,
  blacklist: string[]
): boolean {
  if (blacklist.length === 0) return false;
  const SKIP = new Set([
    "sudo",
    "doas",
    "env",
    "sh",
    "bash",
    "nohup",
    "xargs",
    "timeout"
  ]);
  for (const token of command
    .trim()
    .split(/[\s;&|]+/)) {
    const name = token
      .replace(/["']/g, "")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.toLowerCase();
    if (!name) continue;
    if (SKIP.has(name)) continue;
    if (blacklist.includes(name)) return true;
  }
  return false;
}

/** 解析模型的 tool_call 参数；参数不合法时给出可读错误。 */
export function parseToolArguments(raw: string): {
  command: string;
  question: string;
  isReadOnly: boolean;
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const command =
      typeof parsed.command === "string"
        ? parsed.command
        : "";
    if (!command.trim()) return null;
    return {
      command,
      question:
        typeof parsed.question === "string"
          ? parsed.question
          : "",
      isReadOnly: parsed.is_read_only === true
    };
  } catch {
    return null;
  }
}

/**
 * 解析文件传输工具的参数（`upload_local_file` / `download_remote_file`）。
 *
 * ⚠️ 只有 `remote_path`，**没有本地路径** —— 本地文件由用户在系统弹窗里
 * 亲自挑（见 `adapters.ts` 里 schema 的注释）。远程路径必须是绝对路径：
 * 模型的工作目录概念不可靠，相对路径会传到意想不到的地方。
 */
export function parseFileToolArguments(
  raw: string
): {
  remotePath: string;
  question: string;
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const remotePath =
      typeof parsed.remote_path === "string"
        ? parsed.remote_path.trim()
        : "";
    if (!isAbsoluteRemotePath(remotePath))
      return null;
    return {
      remotePath,
      question:
        typeof parsed.question === "string"
          ? parsed.question
          : ""
    };
  } catch {
    return null;
  }
}

/**
 * 远程路径是否可用：必须是绝对路径（Linux `/`、Windows 盘符或 UNC）。
 *
 * 挡掉 `../../etc/passwd`、`~root/.ssh/id_rsa` 这类 —— 前者靠相对路径
 * 逃出预期目录，后者是 ssh 的波浪号展开语法，很多远程 shell 不认，
 * 直接当字面目录名会传到别处去。
 */
export function isAbsoluteRemotePath(
  value: string
): boolean {
  if (!value) return false;
  if (value.startsWith("/")) return true;
  // UNC：`\\server\share`（Windows 与 Samba 共享）
  if (/^[\\/]{2}[^\\/]/.test(value)) return true;
  // Windows 盘符 `C:\...`；`C:a` 是盘符相对路径，不算绝对
  return /^[a-zA-Z]:[\\/]/.test(value);
}

/** 从当前终端提示符读取目录；没有可识别的提示符时返回 null。 */
export function directoryFromPrompt(
  terminal: Terminal | undefined
): string | null {
  if (!terminal) return null;
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(
    buffer.baseY + buffer.cursorY
  );
  const text =
    line?.translateToString(true) ?? "";
  return (
    text.match(
      /(?:^|\s)[^\s@]+@[^\s:]+:(~(?:\/[^\s#$]*)?|\/[^\s#$]*)[#$](?:\s|$)/
    )?.[1] ?? null
  );
}

/** 单引号安全包裹：路径/文本进 shell 前必用（内嵌单引号按 '\'' 转义）。 */
export function shellQuote(
  value: string
): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 安全地把提示符目录拼进独立 SSH 命令。 */
export function commandInDirectory(
  directory: string,
  command: string
): string {
  const path =
    directory === "~"
      ? '"$HOME"'
      : directory.startsWith("~/")
        ? `"$HOME"/${shellQuote(directory.slice(2))}`
        : shellQuote(directory);
  return `cd -- ${path} || exit 1\n${command}`;
}

/** 计划步骤数上限：计划卡要全量展示，几十步的「计划」实际是模型没拆干净。 */
export const PLAN_STEP_LIMIT = 12;

/** 反问题数上限：一题一屏，题多了用户会烦；默认放 5 题以内。 */
export const ASK_QUESTION_LIMIT = 5;

/** 单次文件改动的查找/替换块上限：一次卡里堆太多处人就懒得审了。 */
export const EDIT_BLOCK_LIMIT = 20;

/** 单题候选项上限：加上客户端的「其他」项，一屏放 7 个以内。 */
export const ASK_OPTION_LIMIT = 6;

/** propose_plan 工具解析出的步骤（is_read_only 缺省按读写算，见下）。 */
export type PlanToolStep = {
  title: string;
  detail?: string;
  command: string;
  isReadOnly: boolean;
};

/**
 * 解析 propose_plan 工具的参数：标题 + 摘要 + 至少一步。
 *
 * ⚠️ 任何一步缺 title / command 都**整份作废**（返回 null）而不是静默
 * 跳过：少一步的计划照样跑会改坏服务器，让模型重给一份完整的更安全。
 * ⚠️ `is_read_only` 缺省按 **false（读写）** 算：标错的只读只是白等
 * 一次确认，标错的读写会自动改服务器状态，宁可前者。
 */
export function parsePlanToolArguments(
  raw: string
): {
  title: string;
  summary: string;
  steps: PlanToolStep[];
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const title =
      typeof parsed.title === "string"
        ? parsed.title.trim()
        : "";
    if (!title) return null;
    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary.trim()
        : "";
    if (!Array.isArray(parsed.steps)) return null;
    const steps: PlanToolStep[] = [];
    for (const item of parsed.steps) {
      if (!item || typeof item !== "object")
        return null;
      const step = item as Record<
        string,
        unknown
      >;
      const stepTitle =
        typeof step.title === "string"
          ? step.title.trim()
          : "";
      const command =
        typeof step.command === "string"
          ? step.command.trim()
          : "";
      if (!stepTitle || !command) return null;
      const detail =
        typeof step.detail === "string"
          ? step.detail.trim()
          : "";
      steps.push({
        title: stepTitle,
        ...(detail ? { detail } : {}),
        command,
        isReadOnly: step.is_read_only === true
      });
      if (steps.length >= PLAN_STEP_LIMIT)
        return null;
    }
    if (steps.length === 0) return null;
    return { title, summary, steps };
  } catch {
    return null;
  }
}

/**
 * 解析 ask_questions 工具的参数：标题 + 至少一题。
 *
 * ⚠️ 任何一题缺 id / prompt / options 都**整份作废**（返回 null）——
 * 少一题的反问会让模型基于不完整的信息继续，比让它重问更糟。
 * ⚠️ 题目 id 必须互不重复：作答按 id 归键，重复会串答案。
 * 「其他」自由输入项由客户端渲染，不进参数 —— 模型只给候选项。
 */
export function parseAskToolArguments(
  raw: string
): {
  title: string;
  questions: {
    id: string;
    prompt: string;
    options: string[];
  }[];
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const title =
      typeof parsed.title === "string"
        ? parsed.title.trim()
        : "";
    if (!Array.isArray(parsed.questions))
      return null;
    const questions: {
      id: string;
      prompt: string;
      options: string[];
    }[] = [];
    const seenIds = new Set<string>();
    for (const item of parsed.questions) {
      if (!item || typeof item !== "object")
        return null;
      const question = item as Record<
        string,
        unknown
      >;
      const id =
        typeof question.id === "string"
          ? question.id.trim()
          : "";
      const prompt =
        typeof question.prompt === "string"
          ? question.prompt.trim()
          : "";
      if (!id || !prompt) return null;
      if (seenIds.has(id)) return null;
      if (!Array.isArray(question.options))
        return null;
      const options: string[] = [];
      for (const option of question.options) {
        if (typeof option !== "string")
          return null;
        const text = option.trim();
        if (!text) return null;
        options.push(text);
        if (options.length >= ASK_OPTION_LIMIT)
          break;
      }
      if (options.length === 0) return null;
      seenIds.add(id);
      questions.push({ id, prompt, options });
      if (questions.length >= ASK_QUESTION_LIMIT)
        break;
    }
    if (questions.length === 0) return null;
    return { title, questions };
  } catch {
    return null;
  }
}

/**
 * 解析 edit_remote_file 工具的参数：绝对路径 + 说明 + 至少一处替换块。
 *
 * ⚠️ 任何一处缺 old_string / new_string → 整份作废（返回 null）：半套
 * 替换应用到文件里就是改坏。路径必须是绝对路径（同文件传输的规矩）。
 */
export function parseEditToolArguments(
  raw: string
): {
  path: string;
  summary: string;
  edits: {
    oldString: string;
    newString: string;
  }[];
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    const path =
      typeof parsed.path === "string"
        ? parsed.path.trim()
        : "";
    if (!path) return null;
    if (!isAbsoluteRemotePath(path)) return null;
    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary.trim()
        : "";
    if (!Array.isArray(parsed.edits)) return null;
    const edits: {
      oldString: string;
      newString: string;
    }[] = [];
    for (const item of parsed.edits) {
      if (!item || typeof item !== "object")
        return null;
      const edit = item as Record<
        string,
        unknown
      >;
      const oldString =
        typeof edit.old_string === "string"
          ? edit.old_string
          : "";
      const newString =
        typeof edit.new_string === "string"
          ? edit.new_string
          : "";
      // 空 old_string 会匹配到文件任意位置（indexOf("")=0），必须挡掉
      if (!oldString || !newString) return null;
      edits.push({ oldString, newString });
      if (edits.length >= EDIT_BLOCK_LIMIT) break;
    }
    if (edits.length === 0) return null;
    return { path, summary, edits };
  } catch {
    return null;
  }
}

/**
 * 计划步骤是否按现有开关自动执行。
 *
 * 与 runLoop 里单条命令**同一套规则**（抽成纯函数供两边共用）：
 * 只读步骤看「自动执行」，读写步骤看「自动应用」，黑名单永不自动执行
 * —— 即使开关全开，命中黑名单的步骤也回落为单独确认。
 */
export function planStepAutoRuns(
  step: {
    command: string;
    isReadOnly: boolean;
  },
  options: {
    autoExecute: boolean;
    autoApply: boolean;
    blacklist: string[];
  }
): boolean {
  if (
    isBlacklisted(step.command, options.blacklist)
  )
    return false;
  return step.isReadOnly
    ? options.autoExecute
    : options.autoApply;
}
