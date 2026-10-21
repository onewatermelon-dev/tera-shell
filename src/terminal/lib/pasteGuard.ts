/**
 * 粘贴防护：判断一段要粘进终端的内容是否值得拦一下。
 *
 * ## 为什么前端要单独做这一层
 *
 * AI 工具链有黑名单（见 ai/tools.ts 的 `isBlacklisted`），但那只管
 * **AI 发出的命令**。用户自己从聊天窗口、网页、文档里粘一段脚本进终端，
 * 全程没有任何拦截 —— 而运维事故里「多粘了一行」「粘的是上一条命令的
 * 变体」占很大比例。终端粘贴是**批量**输入，一次回车就全执行了，
 * 不像手敲还能逐字察觉。
 *
 * ## 判据
 *
 * 1. **行数 > 3**：粘贴三行以上的脚本，几乎必然含有用户没逐字看过的命令；
 * 2. **危险模式**：`rm -rf`、`dd of=`、`mkfs`、`chmod 777 /`、fork bomb ——
 *    这一类误操作不可逆，值得多问一句。
 *
 * 判定是**纯函数**，返回风险 id 列表（文案由 UI 层翻译），
 * 方便单测也方便以后加规则。
 */

/** 粘贴超过这么多行（非空行）就提示。 */
export const MULTILINE_THRESHOLD = 3;

/** 风险种类。 */
export type PasteRiskId =
  | "multiline"
  | "rm-rf"
  | "dd"
  | "mkfs"
  | "chmod-root"
  | "fork-bomb";

/** 一条命中的风险（多行风险带上行数，便于文案里说明）。 */
export type PasteRisk = {
  id: PasteRiskId;
  /** 仅 multiline 有值：非空行数 */
  lines?: number;
};

/** 评估结果。 */
export type PasteAssessment = {
  /** 是否值得弹确认 */
  risky: boolean;
  /** 非空行数 */
  lines: number;
  /** 命中的风险（同一类只记一次，按规则表顺序） */
  risks: PasteRisk[];
};

/**
 * 统计非空行数。
 *
 * 空行不算：脚本里常拿空行分段，按物理行数数会把 2 行的命令判成 4 行。
 *
 * @param text 待粘贴文本
 */
export function countLines(text: string): number {
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) lines += 1;
  }
  return lines;
}

/**
 * 是否 `rm` 带递归 + 强制。
 *
 * 不能简单匹配 `-rf`：`rm -r -f x`、`rm -fR x`、`rm --recursive --force x`
 * 都是同一件事。所以分开判断「有递归」与「有强制」，两个都在才算。
 */
function isRecursiveForceRm(
  line: string
): boolean {
  if (!/\brm\b/.test(line)) return false;
  const recursive =
    /(?:^|\s)-[a-z]*r[a-z]*(?=\s|$)/i.test(
      line
    ) || /--recursive\b/.test(line);
  const force =
    /(?:^|\s)-[a-z]*f[a-z]*(?=\s|$)/i.test(
      line
    ) || /--force\b/.test(line);
  return recursive && force;
}

/** 单行危险模式（`[^\n]` 而不是 `.`：不允许跨行误判）。 */
const LINE_RULES: {
  id: PasteRiskId;
  test: (line: string) => boolean;
}[] = [
  // dd 写设备：一条命令就能覆盖磁盘
  {
    id: "dd",
    test: line => /\bdd\b[^\n]*\bof=/.test(line)
  },
  // 格式化文件系统
  {
    id: "mkfs",
    test: line => /\bmkfs(\.\w+)?\b/.test(line)
  },
  // 把根目录开成 777（含 -R 递归）
  {
    id: "chmod-root",
    test: line =>
      /\bchmod\b[^\n]*\b777\b[^\n]*\s\/(?:\s|$)/.test(
        line
      )
  },
  // fork bomb：`:(){ :|:& };:`
  {
    id: "fork-bomb",
    test: line =>
      /:\(\)\s*\{[^\n]*:\s*\|\s*:[^\n]*\}\s*;?\s*:/.test(
        line
      )
  }
];

/**
 * 评估一段粘贴内容。
 *
 * @param text 剪贴板里的纯文本
 */
export function assessPaste(
  text: string
): PasteAssessment {
  const lines = countLines(text);
  const risks: PasteRisk[] = [];
  if (lines > MULTILINE_THRESHOLD)
    risks.push({ id: "multiline", lines });
  let sawRm = false;
  for (const line of text.split(/\r?\n/)) {
    // rm 需要「递归 + 强制」两个条件，单独抽出判断
    if (!sawRm && isRecursiveForceRm(line)) {
      sawRm = true;
      risks.push({ id: "rm-rf" });
    }
    for (const rule of LINE_RULES) {
      if (risks.some(item => item.id === rule.id))
        continue;
      if (rule.test(line))
        risks.push({ id: rule.id });
    }
  }
  return {
    risky: risks.length > 0,
    lines,
    risks
  };
}
