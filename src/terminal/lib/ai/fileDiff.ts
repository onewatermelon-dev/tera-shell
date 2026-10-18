/**
 * 文件改动的纯函数层：应用「查找/替换」块、算行级 diff、切 hunk。
 *
 * 全部纯函数、不碰 DOM 与 IPC —— 匹配规则与 diff 形态是这套「先出
 * diff 再应用」的安全底线，必须可单测。
 */
import type {
  AiDiffHunk,
  AiDiffLine
} from "./protocol";

/** diff 预览的内容上限：超过就不给逐行 diff（防大文件 O(n·m) 爆内存）。 */
export const FILE_DIFF_LIMIT = 256 * 1024;

/** LCS DP 的单元格上限：超过就退化成「整块替换」，不做行间对齐。 */
const DP_CELL_LIMIT = 4_000_000;

/** 每个 hunk 保留的上下文行数（git 默认 3）。 */
const HUNK_CONTEXT = 3;

/** 扩展名 → 语法高亮语言（cli-highlight / Highlight.js 的语言名）。 */
const EXTENSION_LANGUAGES: Record<
  string,
  string
> = {
  // 脚本 / 配置
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  conf: "ini",
  cfg: "ini",
  ini: "ini",
  toml: "ini",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  // 代码
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  rs: "rust",
  go: "go",
  java: "java",
  php: "php",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  // 容器 / 构建
  dockerfile: "dockerfile",
  mk: "makefile"
};

/** 无扩展名（或点开头）的知名文件名 → 语言。 */
const NAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "nginx.conf": "ini",
  nginx: "ini",
  sshd_config: "ini",
  ssh_config: "ini",
  hosts: "ini",
  fstab: "ini",
  crontab: "ini",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".profile": "bash"
};

/**
 * 文件路径 → 语法高亮语言名。
 *
 * 探不出的一律 `plaintext`（着色管线对 plaintext 原样透传，不染错色）
 * —— 运维场景常见的就那几类配置，认不出来比猜错好。
 */
export function diffLanguageFor(
  path: string
): string {
  const name =
    path.split("/").pop()?.toLowerCase() ?? "";
  if (!name) return "plaintext";
  const byName = NAME_LANGUAGES[name];
  if (byName) return byName;
  const extension = name.includes(".")
    ? (name.split(".").pop() ?? "")
    : "";
  return (
    EXTENSION_LANGUAGES[extension] ?? "plaintext"
  );
}

/** 报错信息里的原文预览长度。 */
const PREVIEW_CHARS = 60;

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > PREVIEW_CHARS
    ? `${oneLine.slice(0, PREVIEW_CHARS)}…`
    : oneLine;
}

/**
 * 把「查找/替换」块按顺序应用到内容上。
 *
 * ⚠️ 每个 old_string 必须**唯一匹配**：匹配 0 次说明模型看到的文件
 * 版本已过期（或它在编造），匹配多次说明替换目标不明确 —— 两种都
 * 直接失败，不猜、不取第一个。空 old_string 更不行（会匹配到任意
 * 位置），由调用方（parseEditToolArguments）先行挡掉。
 */
export function applyEdits(
  content: string,
  edits: {
    oldString: string;
    newString: string;
  }[]
):
  | { ok: true; newContent: string }
  | { ok: false; reason: string } {
  let result = content;
  for (const edit of edits) {
    const first = result.indexOf(edit.oldString);
    if (first === -1)
      return {
        ok: false,
        reason: `找不到要替换的内容（文件里没有这段原文）：${preview(edit.oldString)}`
      };
    if (
      result.indexOf(
        edit.oldString,
        first + 1
      ) !== -1
    )
      return {
        ok: false,
        reason: `要替换的内容在文件里出现多次，无法确定改哪处：${preview(edit.oldString)}`
      };
    result =
      result.slice(0, first) +
      edit.newString +
      result.slice(first + edit.oldString.length);
  }
  return { ok: true, newContent: result };
}

/** 按行切分（保留空行；不保留换行符）。 */
function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split("\n");
}

/**
 * 行级 diff：公共前缀/后缀裁剪 + LCS 对齐。
 *
 * 裁剪是关键：配置改动集中在局部，裁完通常只剩几百行，DP 内存可控；
 * 不裁的话 5000 行的文件就要 25M 单元格。裁剪后仍超 DP_CELL_LIMIT 时
 * 退化成「中间整块删 + 整块增」—— 统计准确，只是没有行间对齐。
 */
export function computeLineDiff(
  oldText: string,
  newText: string
): {
  lines: AiDiffLine[];
  added: number;
  removed: number;
} {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  // 公共前缀
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start++;
  // 公共后缀
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  const oldMid = oldLines.slice(start, endOld);
  const newMid = newLines.slice(start, endNew);

  const lines: AiDiffLine[] = [];
  // 前缀上下文
  for (let index = 0; index < start; index++)
    lines.push({
      kind: "context",
      text: oldLines[index] ?? "",
      oldLine: index + 1,
      newLine: index + 1
    });

  let added = 0;
  let removed = 0;
  const pushMid = (
    kind: AiDiffLine["kind"],
    text: string,
    oldLine?: number,
    newLine?: number
  ) => {
    if (kind === "add") added++;
    if (kind === "remove") removed++;
    lines.push({ kind, text, oldLine, newLine });
  };

  if (
    (oldMid.length + 1) * (newMid.length + 1) <=
    DP_CELL_LIMIT
  ) {
    alignMiddle(oldMid, newMid, start, pushMid);
  } else {
    // 降级：整块替换
    oldMid.forEach((text, index) =>
      pushMid("remove", text, start + index + 1)
    );
    newMid.forEach((text, index) =>
      pushMid(
        "add",
        text,
        undefined,
        start + index + 1
      )
    );
  }

  // 后缀上下文
  for (
    let index = 0;
    index < oldLines.length - endOld;
    index++
  )
    lines.push({
      kind: "context",
      text: oldLines[endOld + index] ?? "",
      oldLine: endOld + index + 1,
      newLine: endNew + index + 1
    });

  return { lines, added, removed };
}

/** LCS 回溯对齐中间段；行号从 1 起、偏移 start。 */
function alignMiddle(
  oldMid: string[],
  newMid: string[],
  start: number,
  push: (
    kind: AiDiffLine["kind"],
    text: string,
    oldLine?: number,
    newLine?: number
  ) => void
) {
  const n = oldMid.length;
  const m = newMid.length;
  const width = m + 1;
  // dp[i*width+j] = oldMid[i..] 与 newMid[j..] 的 LCS 长度
  const dp = new Int32Array((n + 1) * width);
  // 下标读取收口成 helper：Int32Array 在 noUncheckedIndexedAccess 下
  // 也是 number|undefined，而 dp 全量初始化过，缺省即 0
  const at = (row: number, col: number) =>
    dp[row * width + col] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * width + j] =
        oldMid[i] === newMid[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      push(
        "context",
        oldMid[i] ?? "",
        start + i + 1,
        start + j + 1
      );
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push(
        "remove",
        oldMid[i] ?? "",
        start + i + 1
      );
      i++;
    } else {
      push(
        "add",
        newMid[j] ?? "",
        undefined,
        start + j + 1
      );
      j++;
    }
  }
  while (i < n) {
    push(
      "remove",
      oldMid[i] ?? "",
      start + i + 1
    );
    i++;
  }
  while (j < m) {
    push(
      "add",
      newMid[j] ?? "",
      undefined,
      start + j + 1
    );
    j++;
  }
}

/**
 * 把完整 diff 行序列切成带上下文的 hunk。
 *
 * 相邻变更块间隔小于 2×context 时合并（git 同款行为）—— 配置文件的
 * 改动常常集中在相邻几行，切成七八个 hunk 反而没法读。
 */
export function buildHunks(
  lines: AiDiffLine[],
  context = HUNK_CONTEXT
): AiDiffHunk[] {
  const changeIndices: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== "context")
      changeIndices.push(index);
  });
  if (changeIndices.length === 0) return [];

  const hunks: AiDiffHunk[] = [];
  const firstChange = changeIndices[0] ?? 0;
  let groupStart = Math.max(
    0,
    firstChange - context
  );
  let groupEnd = Math.min(
    lines.length - 1,
    firstChange + context
  );
  const flush = () => {
    const slice = lines.slice(
      groupStart,
      groupEnd + 1
    );
    const firstOld = slice.find(
      line => line.oldLine != null
    )?.oldLine;
    const firstNew = slice.find(
      line => line.newLine != null
    )?.newLine;
    hunks.push({
      lines: slice,
      oldStart: firstOld ?? 1,
      newStart: firstNew ?? 1
    });
  };
  for (let k = 1; k < changeIndices.length; k++) {
    const index = changeIndices[k] ?? 0;
    if (index - context <= groupEnd + 1) {
      groupEnd = Math.min(
        lines.length - 1,
        index + context
      );
    } else {
      flush();
      groupStart = Math.max(0, index - context);
      groupEnd = Math.min(
        lines.length - 1,
        index + context
      );
    }
  }
  flush();
  return hunks;
}
