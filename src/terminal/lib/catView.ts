/**
 * cat 查看文件的语法高亮：拦截 `cat <文件>` 命令，经 exec 通道拉取内容，
 * cli-highlight（Highlight.js 内核）转成 ANSI 码后写回终端 —— 颜色由当前
 * 配色方案的 ANSI 色渲染，换主题跟着变。
 *
 * vim 不在这里：vim 是交互 TUI，配色通过部署远端 ~/.vim/plugin 自动加载
 * 脚本生效，用户的 `vim 文件` 命令原样放行。
 */
import chalk, { type Chalk } from "chalk";

// cli-highlight 的颜色经 chalk 输出，chalk 在非 TTY 环境（WebView 里没有
// 真终端）自动把 level 降到 0 = 全灰。这里是纯数据加工，强制全彩。
// chalk@4 与 cli-highlight 内部依赖同版本，pnpm 解析到同一实例才生效。
chalk.level = 3;

/** 匹配 `cat <文件>`：仅单文件、无选项的形式被拦截，其余原样放行。
 *  路径可以是裸 token，也可以是引号包裹（内部允许空格）。 */
export function parseCatCommand(
  line: string
): string | null {
  const match =
    /^cat\s+("([^"]*)"|'([^']*)'|(\S+))$/.exec(
      line.trim()
    );
  const path =
    match?.[2] ?? match?.[3] ?? match?.[4];
  if (!path) return null;
  // shell 元字符不拦（重定向/管道/通配让远端自己处理）
  if (/[><|;*?$`&]/.test(path)) return null;
  return path;
}

/** 匹配 `vim/vi/view <文件>`：仅用于识别，不改写命令 —— 配色由部署到
 *  ~/.vim/plugin 的自动加载脚本生效（见 VIM_SCHEME_SETUP），用户敲什么
 *  就执行什么，命令行与远端 history 保持原样。 */
export function isVimCommand(
  line: string
): boolean {
  return /^(vim?|view)\s+\S/.test(line.trim());
}

/**
 * One Dark Pro 的 vim 配色部署：首次使用时写入远端
 * ~/.vim/colors/OneDarkPro.vim + ~/.vim/plugin/terashell-onedark.vim
 * （已存在则跳过，不动用户自己的配置）。plugin 文件让所有 vim 会话
 * 自动应用该配色，无需改写用户的命令行。
 * termguicolors 可用时走真彩，否则退 256 色近似。
 */
export const VIM_SCHEME_SETUP = [
  `[ -f "$HOME/.vim/plugin/terashell-onedark.vim" ] && exit 0`,
  `mkdir -p "$HOME/.vim/colors" "$HOME/.vim/plugin"`,
  `cat > "$HOME/.vim/colors/OneDarkPro.vim" <<'VIMRC'`,
  `" One Dark Pro —— 由 Tera Shell 部署（覆盖常用高亮组）`,
  `if has('termguicolors') | set termguicolors | endif`,
  `hi clear`,
  `syntax reset`,
  `let g:colors_name = 'OneDarkPro'`,
  `hi Normal ctermfg=249 guifg=#abb2bf`,
  `hi Comment ctermfg=243 guifg=#5c6370 gui=italic cterm=italic`,
  `hi Constant ctermfg=179 guifg=#d19a66`,
  `hi Number ctermfg=179 guifg=#d19a66`,
  `hi Boolean ctermfg=179 guifg=#d19a66`,
  `hi Float ctermfg=179 guifg=#d19a66`,
  `hi String ctermfg=114 guifg=#98c379`,
  `hi Character ctermfg=114 guifg=#98c379`,
  `hi Identifier ctermfg=168 guifg=#e06c75`,
  `hi Function ctermfg=74 guifg=#61afef`,
  `hi Statement ctermfg=176 guifg=#c678dd`,
  `hi Conditional ctermfg=176 guifg=#c678dd`,
  `hi Repeat ctermfg=176 guifg=#c678dd`,
  `hi Label ctermfg=176 guifg=#c678dd`,
  `hi Keyword ctermfg=176 guifg=#c678dd`,
  `hi Exception ctermfg=176 guifg=#c678dd`,
  `hi Operator ctermfg=73 guifg=#56b6c2`,
  `hi PreProc ctermfg=176 guifg=#c678dd`,
  `hi Include ctermfg=176 guifg=#c678dd`,
  `hi Define ctermfg=176 guifg=#c678dd`,
  `hi Macro ctermfg=176 guifg=#c678dd`,
  `hi PreCondit ctermfg=176 guifg=#c678dd`,
  `hi Type ctermfg=180 guifg=#e5c07b`,
  `hi StorageClass ctermfg=180 guifg=#e5c07b`,
  `hi Structure ctermfg=180 guifg=#e5c07b`,
  `hi Typedef ctermfg=180 guifg=#e5c07b`,
  `hi Special ctermfg=74 guifg=#61afef`,
  `hi SpecialChar ctermfg=179 guifg=#d19a66`,
  `hi Tag ctermfg=168 guifg=#e06c75`,
  `hi Delimiter ctermfg=249 guifg=#abb2bf`,
  `hi SpecialComment ctermfg=176 guifg=#c678dd`,
  `hi Debug ctermfg=168 guifg=#e06c75`,
  `hi Underlined ctermfg=74 guifg=#61afef gui=underline cterm=underline`,
  `hi Error ctermfg=168 guifg=#e06c75`,
  `hi Todo ctermfg=114 guifg=#98c379 gui=bold cterm=bold`,
  `hi Visual ctermbg=238 guibg=#3e4451`,
  `hi Search ctermfg=28 guifg=#282c34 ctermbg=179 guibg=#d19a66`,
  `hi IncSearch ctermfg=28 guifg=#282c34 ctermbg=114 guibg=#98c379`,
  `hi MatchParen ctermfg=179 guifg=#d19a66 gui=bold cterm=bold`,
  `hi LineNr ctermfg=243 guifg=#5c6370`,
  `hi CursorLineNr ctermfg=179 guifg=#d19a66`,
  `hi CursorLine ctermbg=236 guibg=#2c313a`,
  `hi StatusLine ctermfg=249 guifg=#abb2bf ctermbg=236 guibg=#2c313a`,
  `hi VertSplit ctermfg=236 guifg=#2c313a`,
  `hi NonText ctermfg=243 guifg=#5c6370`,
  `hi Folded ctermfg=243 guifg=#5c6370 ctermbg=236 guibg=#2c313a`,
  `hi Pmenu ctermfg=249 guifg=#abb2bf ctermbg=236 guibg=#2c313a`,
  `hi PmenuSel ctermfg=28 guifg=#282c34 ctermbg=74 guibg=#61afef`,
  `VIMRC`,
  // vim 启动时自动 source ~/.vim/plugin/*.vim，配色由此生效
  `cat > "$HOME/.vim/plugin/terashell-onedark.vim" <<'VIMPLUGIN'`,
  `" Tera Shell 部署：vim 自动应用 One Dark Pro 高亮`,
  `if filereadable(expand('~/.vim/colors/OneDarkPro.vim'))`,
  `  syntax on`,
  `  colorscheme OneDarkPro`,
  `endif`,
  `VIMPLUGIN`
].join("\n");

/** 扩展名 → Highlight.js 语言名（覆盖常见的就够，其余靠自动探测） */
const EXT_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  sql: "sql",
  html: "xml",
  xml: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  dockerfile: "dockerfile",
  makefile: "makefile"
};

/** 从文件路径猜语言；Makefile/Dockerfile 这类无扩展名的按文件名认 */
function detectLanguage(
  path: string
): string | undefined {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (
    lower === "makefile" ||
    lower === "gnumakefile"
  )
    return "makefile";
  if (lower === "dockerfile") return "dockerfile";
  return EXT_LANG[lower.split(".").pop() ?? ""];
}

/** 内容超过这个大小就不做高亮（Highlight.js 在大文件上明显变慢） */
const MAX_HIGHLIGHT_BYTES = 512 * 1024;

/**
 * One Dark Pro（VS Code）token 配色：注释灰、关键字紫、字符串绿、
 * 数字/常量橙、函数蓝、类/内置黄、变量红 —— 真彩 ANSI 固定色，
 * 不随终端配色方案变（VS Code 里它也是固定主题）。
 */
const ONE_DARK_PRO: Record<string, Chalk> = {
  keyword: chalk.hex("#c678dd"),
  "meta-keyword": chalk.hex("#c678dd"),
  doctag: chalk.hex("#c678dd"),
  built_in: chalk.hex("#e5c07b"),
  type: chalk.hex("#e5c07b"),
  class: chalk.hex("#e5c07b"),
  section: chalk.hex("#e5c07b"),
  literal: chalk.hex("#d19a66"),
  number: chalk.hex("#d19a66"),
  attr: chalk.hex("#d19a66"),
  attribute: chalk.hex("#d19a66"),
  bullet: chalk.hex("#d19a66"),
  string: chalk.hex("#98c379"),
  "meta-string": chalk.hex("#98c379"),
  code: chalk.hex("#98c379"),
  addition: chalk.hex("#98c379"),
  title: chalk.hex("#61afef"),
  function: chalk.hex("#61afef"),
  meta: chalk.hex("#61afef"),
  link: chalk.hex("#61afef").underline,
  "builtin-name": chalk.hex("#61afef"),
  "selector-id": chalk.hex("#61afef"),
  comment: chalk.hex("#5c6370").italic,
  quote: chalk.hex("#5c6370").italic,
  params: chalk.hex("#abb2bf"),
  default: chalk.hex("#abb2bf"),
  regexp: chalk.hex("#56b6c2"),
  symbol: chalk.hex("#56b6c2"),
  "selector-pseudo": chalk.hex("#56b6c2"),
  tag: chalk.hex("#e06c75"),
  name: chalk.hex("#e06c75"),
  variable: chalk.hex("#e06c75"),
  "template-variable": chalk.hex("#e06c75"),
  deletion: chalk.hex("#e06c75"),
  "selector-tag": chalk.hex("#e06c75"),
  "selector-class": chalk.hex("#d19a66"),
  "selector-attr": chalk.hex("#c678dd"),
  "template-tag": chalk.hex("#c678dd"),
  formula: chalk.hex("#c678dd"),
  emphasis: chalk.italic,
  strong: chalk.bold,
  subst: chalk.hex("#e06c75")
};

/**
 * 代码 → ANSI 着色文本。cli-highlight 体积不小，动态 import 分包，
 * 首次 cat 时才加载；探测不出语言时交给 Highlight.js 自动探测。
 */
export async function highlightToAnsi(
  code: string,
  path: string
): Promise<string> {
  if (code.length > MAX_HIGHLIGHT_BYTES)
    return code;
  const { highlight } =
    await import("cli-highlight");
  return highlight(code, {
    language: detectLanguage(path),
    theme: ONE_DARK_PRO,
    ignoreIllegals: true
  });
}
