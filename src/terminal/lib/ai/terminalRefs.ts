/**
 * 「@ 引用终端内容」的纯函数层：令牌解析 + 终端快照读取 + 上下文块拼装。
 *
 * 不碰 React 与 Tauri —— aiChat 的 dispatch 在发送瞬间调用，单测用假
 * reader 直接驱动（见 tests/terminalRefs.test.ts）。
 *
 * 设计要点：
 * - 令牌是**纯文本**（@当前屏幕 / @终端回滚 / @选中内容），走编辑器
 *   文本流 —— 入队、历史召回、恢复显示全链路零改动；
 * - 快照在 dispatch 实时读取，不随消息缓存 —— 用户看到的是发送那一刻
 *   的终端状态；
 * - 可见 entry 保留带令牌的原文（用户知道自己引了什么），发给模型的
 *   正文剥掉令牌并追加快照块。
 */

/** 可引用的终端内容类型。 */
export type TerminalRefKind =
  "screen" | "scrollback" | "selection";

/** 一条终端引用。只记类型 —— 内容在发送时实时读取。 */
export type TerminalRef = {
  kind: TerminalRefKind;
};

/** @ 菜单的一项：类型 + 插入输入框的令牌 + 菜单标签的 i18n 键。 */
export type TerminalRefItem = {
  kind: TerminalRefKind;
  /** 插入编辑器的文本令牌，也是发送时的解析依据 */
  token: string;
  /**
   * 菜单显示名（i18n 键）。
   * 收窄成字面量联合而不是宽泛的 string —— t() 的入参是键的联合，
   * 宽类型在这里直接编译不过。
   */
  labelKey:
    | "ai.ref.screen"
    | "ai.ref.scrollback"
    | "ai.ref.selection";
};

/** 回滚引用默认携带的行数（含视口，往上数）。 */
export const SCROLLBACK_LINES = 200;

/** 全部引用项。菜单按此顺序展示，解析正则也按此顺序拼接。 */
export const TERMINAL_REF_ITEMS: TerminalRefItem[] =
  [
    {
      kind: "screen",
      token: "@当前屏幕",
      labelKey: "ai.ref.screen"
    },
    {
      kind: "scrollback",
      token: "@终端回滚",
      labelKey: "ai.ref.scrollback"
    },
    {
      kind: "selection",
      token: "@选中内容",
      labelKey: "ai.ref.selection"
    }
  ];

/**
 * 从待发送文本里解析 @ 令牌。
 *
 * 按出现顺序收集引用类型（文本里的顺序即快照块在提示词里的顺序），
 * 同时产出剥掉令牌后的正文。
 *
 * @param text 用户输入（可能含令牌）
 * @returns 剥令牌并收敛空白后的正文 + 引用列表
 */
export function extractTerminalRefs(
  text: string
): {
  text: string;
  refs: TerminalRef[];
} {
  const kindByToken = new Map(
    TERMINAL_REF_ITEMS.map(item => [
      item.token,
      item.kind
    ])
  );
  const pattern = new RegExp(
    TERMINAL_REF_ITEMS.map(item =>
      item.token.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      )
    ).join("|"),
    "g"
  );
  const refs: TerminalRef[] = [];
  const stripped = text.replace(
    pattern,
    token => {
      const kind = kindByToken.get(token);
      if (kind) refs.push({ kind });
      return " ";
    }
  );
  return {
    // 令牌删掉后收敛空白：行内多空格压成一个、行首行尾剃掉
    text: stripped
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim(),
    refs
  };
}

/**
 * 终端读取面的最小结构（xterm 的 Terminal 天然满足）。
 *
 * 抽窄接口是为了单测能用假对象驱动，也为了让本模块不依赖 xterm 类型。
 */
export type TerminalReader = {
  rows: number;
  getSelection: () => string;
  buffer: {
    active: {
      /** 视口顶端在缓冲里的行号（0 = 没有回滚） */
      baseY: number;
      getLine: (y: number) =>
        | {
            translateToString: (
              trimRight?: boolean
            ) => string;
          }
        | undefined;
    };
  };
};

/**
 * 读取一类终端引用的内容（纯文本行，已去右空白与尾部空行）。
 *
 * - screen：视口可见的 rows 行；
 * - scrollback：视口 + 向上最多 SCROLLBACK_LINES 行回滚
 *   （用户翻上去看日志时，快照以其视口为锚）；
 * - selection：终端当前选区，无选区返回空数组。
 *
 * @param terminal 终端读取面
 * @param kind 引用类型
 * @returns 文本行（可能为空数组）
 */
export function readTerminalLines(
  terminal: TerminalReader,
  kind: TerminalRefKind
): string[] {
  if (kind === "selection") {
    const selected = terminal.getSelection();
    if (!selected) return [];
    return selected
      .split("\n")
      .map(line => line.trimEnd());
  }
  const { active } = terminal.buffer;
  const viewportEnd =
    active.baseY + terminal.rows - 1;
  const start =
    kind === "screen"
      ? active.baseY
      : Math.max(
          0,
          viewportEnd - SCROLLBACK_LINES + 1
        );
  const lines: string[] = [];
  for (let y = start; y <= viewportEnd; y++) {
    const line = active.getLine(y);
    if (!line) continue;
    lines.push(line.translateToString(true));
  }
  // 屏幕快照末尾常带一片空行（提示符在最底下），剃掉省 token
  while (
    lines.length > 0 &&
    lines[lines.length - 1] === ""
  )
    lines.pop();
  return lines;
}

/**
 * 把一类终端引用包成给模型看的上下文块。
 *
 * XML 式标签（与 workspaceContext 的 `<current_workspace>` 同一套
 * 语言），标签名即语义，行数写进属性方便模型判断内容完整性。
 *
 * @param kind 引用类型
 * @param lines readTerminalLines 的结果
 * @returns 上下文本块（空内容时给一句占位说明）
 */
export function formatTerminalRefBlock(
  kind: TerminalRefKind,
  lines: string[]
): string {
  const tag = `terminal_${kind}`;
  const note =
    kind === "screen"
      ? "用户正在看的终端屏幕（视口可见内容）"
      : kind === "scrollback"
        ? `用户向上翻看的终端回滚（视口加最近 ${SCROLLBACK_LINES} 行）`
        : "用户在终端里框选的文本";
  const body = lines.join("\n");
  if (!body.trim())
    return `<${tag} note="${note}">（空）</${tag}>`;
  return `<${tag} lines="${lines.length}" note="${note}">
${body}
</${tag}>`;
}
