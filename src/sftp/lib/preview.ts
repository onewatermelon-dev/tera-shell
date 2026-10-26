/**
 * 内置预览的文件类型判定：按扩展名分流双击行为。
 *
 * 判定是启发式白名单——不在表里的扩展名走原路径（外部打开），
 * 不猜 MIME。
 */

/** 图片扩展名（data URL 直拼 base64，浏览器原生渲染）。 */
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif"
]);

/** 常见文本扩展名。日志/配置/代码，运维预览的主力。 */
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "log",
  "json",
  "yaml",
  "yml",
  "xml",
  "csv",
  "tsv",
  "ini",
  "conf",
  "config",
  "toml",
  "env",
  "properties",
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "py",
  "js",
  "ts",
  "tsx",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "rb",
  "lua",
  "pl",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "dockerfile",
  "makefile",
  "gitignore",
  "editorconfig",
  "service",
  "nginx",
  "htaccess"
]);

/** 双击预览的分流结果。null = 不认识，走外部打开。 */
export type PreviewKind = "image" | "text";

/** 按文件名判定预览类型（大小写不敏感）。 */
export function previewKind(
  name: string
): PreviewKind | null {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf(".");
  // dot>0：常规扩展名（app.log → log）；dot===0（.env）取去掉点后的
  // 约定名；无点（Makefile）用整名 —— 三种都落在同一张表上
  const ext =
    dot > 0
      ? base.slice(dot + 1)
      : dot === 0
        ? base.slice(1)
        : base;
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  return null;
}

/** 文件名取basename（两种分隔符都切，远程恒为 /）。 */
export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
