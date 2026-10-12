/**
 * AI 回答里代码块的语法着色。
 *
 * ## 为什么 Streamdown 默认是纯色的
 *
 * 它的 `CodeBlock` 有两条路：传了 `plugins.code`（Shiki 插件）就按 token
 * 上色，没传就走 `co` 兜底渲染 —— 每个 token 的 `color` 都是
 * `"inherit"`，也就是**整块一个颜色**。所以不配插件 = 没有任何着色。
 *
 * Shiki 那套要额外装 `@streamdown/code`（体积不小，且要异步 wasm）。
 * 本项目已经有 `cli-highlight`（Highlight.js 内核）给终端 `cat` 着色用了，
 * 同一份依赖再做一个适配层最省 —— Highlight.js 的语言覆盖对这个场景
 * （shell / json / yaml / python 那些）完全够。
 *
 * ## 适配思路
 *
 * `cli-highlight` 的输出是 **ANSI 字符串**（`\x1b[38;2;R;G;Bm…\x1b[39m`），
 * 而 Streamdown 的 `HighlightResult` 要的是 `tokens[][]`（每行一组 token，
 * 每个 token 带 `color`）。中间用 `ansiToTokens` 拆 —— 这是本文件里唯一
 * 有难度的部分，单独抽成纯函数好单测。
 *
 * ⚠️ **必须 `chalk.level = 3`**：chalk 检测到不是真 TTY（WebView 里就是）
 * 会把 level 降到 0 = 输出纯文本，一个 ANSI 码都没有。这和 `catView.ts`
 * 是同一个坑。
 */

import chalk, { type Chalk } from "chalk";
import type { CodeHighlighterPlugin } from "streamdown";

// ⚠️ Streamdown 的 `HighlightResult` / `HighlightToken` **没有 export**
// （只在 .d.ts 里 declare，运行时也用不到），所以这里按它的结构本地
// 复刻一份。字段名与 .d.ts 保持一致 —— 少一个字段 TS 不会报错，
// 但 Streamdown 读不到，颜色就静默丢失。
export interface HighlightToken {
  bgColor?: string;
  color?: string;
  content: string;
  htmlAttrs?: Record<string, string>;
  htmlStyle?: Record<string, string>;
  offset?: number;
}

export interface HighlightResult {
  bg?: string;
  fg?: string;
  rootStyle?: string | false;
  tokens: HighlightToken[][];
}

/**
 * `highlight` 的入参。Streamdown 会连 `themes` 一起传进来，但那是给它
 * 自己那套 Shiki 主题用的 —— 本插件的配色写死在 `HLJS_THEME` 里，所以
 * 这里声明成可选（顺带让单测不必构造它）。
 */
interface HighlightOptions {
  code: string;
  language: string;
  /**
   * Streamdown 会连主题一起传进来（`ThemeInput`，可能是字符串也可能是
   * 注册对象），但那是给它自己那套 Shiki 用的 —— 本插件的配色写死在
   * `LIGHT_PALETTE` / `DARK_PALETTE` 里，所以类型放宽到 `unknown` 且可选
   *（顺带让单测不必构造它）。
   *
   * ⚠️ 不能写成 `string[]`：Streamdown 传的是 `ThemeInput`，
   * 函数参数是逆变的 —— 声明得比实际窄会在赋值处直接报 TS2322。
   */
  themes?: unknown;
}

// 同catView.ts：WebView 里没有真 TTY，chalk 会自动降级成全灰。
// ⚠️ 还要显式 `new Chalk({ level: 3 })`：默认导出的那个实例在 ESM
// 互操作下未必是同一个对象，level 不一定传得进去，而 cli-highlight
// 内部用的正是默认实例 —— 必须两边都是 3。
chalk.level = 3;
const forcedChalk = new chalk.Instance({
  level: 3
});

/** 超过这个字节数就不着色了：逐字符拆 token 成本高，长文本不值当。 */
export const MAX_HIGHLIGHT_BYTES = 200_000;

/**
 * 配色的**色值表**（不是 chalk 实例）：同一份色值要分别喂给浅色和深色
 * 两次高亮，再合并成一个 token（见 `mergeThemedTokens`）。
 *
 * 浅色这套是 One Light —— 深色那套（One Dark，`#98c379` 亮绿、
 * `#5c6370` 灰）放到白底上对比度几乎为零，会「有颜色但看不清」。
 *
 * ⚠️ key 必须覆盖 Highlight.js 会用到的**全部** scope，少一个不会报错，
 * 只是那类 token 没颜色 —— 表现为「某些关键字有颜色、有些不有」，
 * 很难看出是漏配。
 */
type Palette = Record<string, string>;

const LIGHT_PALETTE: Palette = {
  comment: "#a0a1a7",
  quote: "#a0a1a7",
  doctag: "#a0a1a7",
  keyword: "#a626a4",
  "selector-tag": "#e45649",
  subst: "#e45649",
  number: "#986801",
  literal: "#986801",
  variable: "#e45649",
  "template-variable": "#e45649",
  attr: "#986801",
  builtin: "#c18401",
  string: "#50a14f",
  doctype: "#6c6c6c",
  title: "#4078f2",
  section: "#4078f2",
  "selector-id": "#4078f2",
  "selector-class": "#4078f2",
  "selector-attr": "#4078f2",
  "selector-pseudo": "#0184bc",
  "template-tag": "#e45649",
  "template-selector-attr": "#0184bc",
  "selector-pseudo-element": "#0184bc",
  type: "#c18401",
  class: "#c18401",
  "class-title": "#c18401",
  built_in: "#c18401",
  class_built_in: "#c18401",
  param: "#986801",
  function: "#4078f2",
  "function-title": "#4078f2",
  property: "#4078f2",
  regex: "#50a14f",
  regexp: "#50a14f",
  symbol: "#4078f2",
  constant: "#986801",
  boolean: "#986801",
  meta: "#4078f2",
  "meta-keyword": "#a626a4",
  "meta-string": "#50a14f",
  punctuation: "#383a42",
  operator: "#0184bc",
  tag: "#e45649",
  deleted: "#e45649",
  inserted: "#50a14f",
  link: "#4078f2",
  entity: "#50a14f",
  "variable.language": "#a626a4"
};

/**
 * 深色这套与 `catView.ts` 的 `ONE_DARK_PRO` 同一套观感 ——
 * 免得终端里 cat 出来的颜色和面板里的对不上。
 */
const DARK_PALETTE: Palette = {
  comment: "#5c6370",
  quote: "#5c6370",
  doctag: "#5c6370",
  keyword: "#c678dd",
  "selector-tag": "#e06c75",
  subst: "#e06c75",
  number: "#d19a66",
  literal: "#d19a66",
  variable: "#e06c75",
  "template-variable": "#e06c75",
  attr: "#d19a66",
  builtin: "#e5c07b",
  string: "#98c379",
  doctype: "#7f848e",
  title: "#61afef",
  section: "#61afef",
  "selector-id": "#61afef",
  "selector-class": "#61afef",
  "selector-attr": "#61afef",
  "selector-pseudo": "#56b6c2",
  "template-tag": "#e06c75",
  "template-selector-attr": "#56b6c2",
  "selector-pseudo-element": "#56b6c2",
  type: "#e5c07b",
  class: "#e5c07b",
  "class-title": "#e5c07b",
  built_in: "#e5c07b",
  class_built_in: "#e5c07b",
  param: "#d19a66",
  function: "#61afef",
  "function-title": "#61afef",
  property: "#61afef",
  regex: "#98c379",
  regexp: "#98c379",
  symbol: "#61afef",
  constant: "#d19a66",
  boolean: "#d19a66",
  meta: "#61afef",
  "meta-keyword": "#c678dd",
  "meta-string": "#98c379",
  punctuation: "#abb2bf",
  operator: "#56b6c2",
  tag: "#e06c75",
  deleted: "#e06c75",
  inserted: "#98c379",
  link: "#61afef",
  entity: "#98c379",
  "variable.language": "#c678dd"
};

/**
 * 色值表 → cli-highlight 认识的 chalk 函数表。
 *
 * 每次现建、别缓存 —— 也就两次高亮各建一次，开销可以忽略。
 */
function toChalkTheme(
  palette: Palette
): Record<string, Chalk> {
  return Object.fromEntries(
    Object.entries(palette).map(([key, hex]) => [
      key,
      forcedChalk.hex(hex)
    ])
  );
}

/** 常用语言别名 → Highlight.js 的语言名。 */
const LANGUAGE_ALIAS: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shell_session: "bash",
  shellsession: "bash",
  yml: "yaml",
  py: "python",
  js: "javascript",
  ts: "typescript",
  htm: "xml",
  html: "xml",
  vue: "xml",
  svg: "xml",
  rs: "rust",
  golang: "go",
  md: "markdown",
  plaintext: "plaintext",
  text: "plaintext",
  txt: "plaintext"
};

/**
 * 语言名归一：补别名 + 小写。
 *
 * 探不出来（Highlight.js 不认的语言）时返回 `plaintext` 而不是原样传 ——
 * cli-highlight 对不认的语言会走自动探测，在 bash 片段上常把整段判成
 * 别的语言，颜色错得莫名其妙。
 */
export function normalizeLanguage(
  language: string | undefined | null
): string {
  const key = (language ?? "")
    .trim()
    .toLowerCase();
  if (!key) return "plaintext";
  return LANGUAGE_ALIAS[key] ?? key;
}

/** `ESC[38;2;R;G;Bm` → `#rrggbb`；其余返回 null。 */
export function truecolorToHex(
  params: string
): string | null {
  const m = /^38;2;(\d+);(\d+);(\d+)$/.exec(
    params
  );
  if (!m) return null;
  const hex = (value: string) =>
    Number(value).toString(16).padStart(2, "0");
  return `#${hex(m[1] ?? "0")}${hex(m[2] ?? "0")}${hex(m[3] ?? "0")}`;
}

/**
 * ANSI 着色文本 → Streamdown 的 `tokens[][]`（每行一组）。
 *
 * 只认两种序列：开前景色的 `38;2;R;G;B` 和复位前景色的 `39`/`0`。
 * 换行一定是裸的 `\n`（chalk 不给换行上色），所以**先按行切再逐行解析**
 * —— 直接全局扫会在跨行状态上出错。
 *
 * 没有颜色的片段合成一个 `color` 缺省的 token（继承前景色）。
 */
export function ansiToTokens(
  ansi: string
): HighlightToken[][] {
  return ansi.split("\n").map(line => {
    const tokens: HighlightToken[] = [];
    // eslint-disable-next-line no-control-regex -- ANSI 转义本身就是控制字符，这里要匹配的正是它
    const pattern = /\x1b\[([0-9;]*)m/g;
    let cursor = 0;
    let color: string | undefined;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      const start = match.index;
      if (start > cursor) {
        tokens.push({
          content: line.slice(cursor, start),
          color
        });
      }
      const params = match[1] ?? "";
      if (params === "0" || params === "39") {
        color = undefined;
      } else {
        color = truecolorToHex(params) ?? color;
      }
      cursor = start + match[0].length;
    }
    if (cursor < line.length) {
      tokens.push({
        content: line.slice(cursor),
        color
      });
    }
    // 空行也要占一行（行号对齐靠它），但别塞空 token
    if (tokens.length === 0)
      tokens.push({ content: "" });
    return tokens;
  });
}

/** 无色结果：每个 token 只有内容，`color` 缺省= 继承前景色。 */
function plainResult(
  code: string
): HighlightResult {
  return {
    tokens: code
      .split("\n")
      .map(line => [{ content: line }])
  };
}

/**
 * 合并浅色 / 深色两份 token。
 *
 * ## Streamdown 的双主题机制
 *
 * 它给每个 token 渲染的 class 是
 * `text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]`
 * —— 浅色读 `--sdm-c`、深色读 `--shiki-dark`。而 `htmlStyle` 里的
 * **任意 key 都会原样写成内联 CSS 变量**（只有 `color` /
 * `background-color` 两个key 被特殊接管成 `--sdm-c` / `--sdm-tbg`）。
 *
 * 所以：`color` 放浅色值，`htmlStyle: { "--shiki-dark": 深色值 }`
 * 就能一套token 同时服务明暗两套配色，**不用在渲染期判断当前主题**。
 *
 * 顺带好处：切换主题不需要清缓存 —— 两个值本来就在同一个 token 里。
 *
 * 返回 `null` 表示两侧分段对不上，调用方应保守回落到纯文本。
 */
export function mergeThemedTokens(
  light: HighlightToken[][],
  dark: HighlightToken[][]
): HighlightToken[][] | null {
  // ⚠️ 先整体校验再逐行 map：不能在中途return null，那会留下半合并的
  // 数组被调用方当成合法结果用（行数对不上、内容错位）。
  const sameShape =
    light.length === dark.length &&
    light.every(
      (line, row) =>
        line.length === (dark[row]?.length ?? -1)
    );
  if (!sameShape) return null;
  return light.map((line, row) =>
    line.map((token, col) => {
      const darkColor = dark[row]?.[col]?.color;
      if (!token.color && !darkColor)
        return token;
      return {
        ...token,
        htmlStyle: darkColor
          ? { "--shiki-dark": darkColor }
          : undefined
      };
    })
  );
}

/**
 * 生成 Streamdown 的代码高亮插件。
 *
 * `highlight` 的契约：**同步返回值，没准备好就返回 `null` 并在
 * `callback` 里异步补**。cli-highlight 是动态 import（体积不小，
 * 与 `catView.ts` 同样的理由），首帧必然走 callback 这条路。
 *
 * 注意 Streamdown 每次渲染都会调 `highlight`，所以这里**必须带缓存**，
 * 否则同一个代码块每次 re-render 都要重新拆一遍 token。
 */
export function createCodeHighlighter(): CodeHighlighterPlugin {
  const cache = new Map<
    string,
    HighlightResult | null
  >();
  let loader: Promise<
    typeof import("cli-highlight")
  > | null = null;
  // ⚠️ 必须声明在 `toResult` 之前：`toResult` 里要用它，
  // 而它由 `highlight` 回调写入 —— 顺序反了会撞 TDZ。
  const callbacks = new Map<
    string,
    Array<(result: HighlightResult) => void>
  >();

  const toResult = (
    code: string,
    language: string
  ): HighlightResult | null => {
    if (!loader) loader = import("cli-highlight");
    const key = `${language} ${code}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (code.length > MAX_HIGHLIGHT_BYTES) {
      const plain = plainResult(code);
      cache.set(key, plain);
      return plain;
    }
    void loader
      .then(({ highlight }) => {
        if (cache.has(key)) return;
        try {
          // 同语言同代码下两次高亮的**分段必然一致**（Highlight.js 只按
          // 语法切段，theme 只影响取色），所以能按位置合并。
          const light = ansiToTokens(
            highlight(code, {
              language,
              theme: toChalkTheme(LIGHT_PALETTE),
              ignoreIllegals: true
            })
          );
          const dark = ansiToTokens(
            highlight(code, {
              language,
              theme: toChalkTheme(DARK_PALETTE),
              ignoreIllegals: true
            })
          );
          const tokens = mergeThemedTokens(
            light,
            dark
          );
          if (!tokens) {
            // 两侧分段对不上（理论上不会）—— 宁可不 colouring，
            // 也不能错位把文字染到别的段上。
            cache.set(key, plainResult(code));
            return;
          }
          const result: HighlightResult = {
            tokens
          };
          cache.set(key, result);
          callbacks
            .get(key)
            ?.forEach(cb => cb(result));
        } catch (error) {
          // 高亮失败不是致命问题：退化成无色，别让整块代码块报错
          console.warn(
            "[ai] 代码高亮失败，回退纯文本",
            error
          );
          const plain = plainResult(code);
          cache.set(key, plain);
          callbacks
            .get(key)
            ?.forEach(cb => cb(plain));
        } finally {
          callbacks.delete(key);
        }
      })
      .catch(error => {
        console.warn(
          "[ai] 代码高亮器加载失败",
          error
        );
        callbacks.delete(key);
      });
    return null;
  };

  return {
    name: "shiki",
    type: "code-highlighter",
    getThemes: () => ["one-dark", "one-dark"],
    getSupportedLanguages: () =>
      Object.values(LANGUAGE_ALIAS),
    supportsLanguage: (language: string) =>
      normalizeLanguage(language) !==
        "plaintext" || language === "plaintext",
    highlight: (
      options: HighlightOptions,
      callback?: (result: HighlightResult) => void
    ) => {
      const result = toResult(
        options.code,
        normalizeLanguage(options.language)
      );
      if (result) return result;
      const key = `${normalizeLanguage(options.language)} ${options.code}`;
      const list = callbacks.get(key) ?? [];
      list.push(callback ?? (() => undefined));
      callbacks.set(key, list);
      return null;
    }
  };
}
