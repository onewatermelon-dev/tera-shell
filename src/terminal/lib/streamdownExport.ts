/**
 * Streamdown「导出类」按钮的接管（表格下载）。
 *
 * ## 为什么不能直接用 Streamdown 自带的下载
 *
 * 它是**纯浏览器实现**：内容包成 `Blob` → `URL.createObjectURL` →
 * 建一个 `<a download>` → `click()`。普通浏览器会弹下载框，但 Tauri 的
 * **WebView2 没有注册下载处理器**（`on_download`），这类下载请求被
 * **静默丢弃** —— 点按钮什么都不发生，也不报错。
 *
 * 复制按钮没这个问题：它走 `navigator.clipboard`，那条路 WebView2 是通的。
 *
 * ## 只管表格
 *
 * 代码块的下载钮在 2026-10-15 随代码块外观改造一起退了场 —— 代码块
 * 现在由 AiCodeBlock 自己渲染，「另存为」直接调 `fs_save_text_file`，
 * 不再需要 document 捕获 hack（见 AiCodeBlock.tsx）。
 *
 * ## 做法
 *
 * 在 **document** 上挂**捕获阶段** click，命中表格下载项就
 * `preventDefault` + `stopPropagation` + `stopImmediatePropagation`
 * （不让 Streamdown 的 React onClick 跑），改成调 `fs_save_text_file`
 * 弹系统另存为框落盘。
 *
 * ⚠️ 必须挂 **document 而不是 AI 面板**：表格的「全屏」模式把整张表
 * portal 到 `document.body`，挂在面板元素上的监听器收不到那次点击
 * （症状：面板里能下载，一按全屏就又不行了）。
 *
 * ⚠️ 必须**捕获**阶段：Streamdown 的 onClick 挂在 React 根容器上。
 *
 * ⚠️ 表格的下载按钮**没有 `data-streamdown` 标记**，只能靠 `title`
 * 文本认。而 `title` 来自 Streamdown 的 i18n 词条，本项目**没有传
 * `translations`**，所以固定是默认英文 —— 认英文即可，一旦将来接了
 * 自定义词条，这里要跟着改（已在测试里钉住）。
 *
 * ⚠️ 别改 `components` 去覆盖按钮：Streamdown 的按钮是 CodeBlock /
 * Table **内部**渲染的，`components.code` 覆盖不到。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  defaultTranslations,
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown
} from "streamdown";

/** 表格包装容器，用来往上找 `<table>`。 */
const TABLE_WRAPPER_SELECTOR =
  '[data-streamdown="table-wrapper"]';

/** 表格默认导出文件名（Streamdown 未配 filename 时也是 `table`）。 */
const TABLE_BASE_NAME = "table";

/** 表格下载是下拉菜单，按 `title` 区分两项。 */
const TABLE_CSV_TITLE =
  defaultTranslations.downloadTableAsCsv;
const TABLE_MARKDOWN_TITLE =
  defaultTranslations.downloadTableAsMarkdown;

/** 表格导出的两种格式。 */
export type TableFormat = "csv" | "markdown";

/**
 * 点了哪个表格下载项。返回 `null` 表示不是表格下载按钮。
 *
 * 独立成纯函数：DOM 探测在 node 环境下测不了，判定逻辑必须能单测。
 */
export function tableFormatOf(
  title: string | null | undefined
): TableFormat | null {
  if (title === TABLE_CSV_TITLE) return "csv";
  if (title === TABLE_MARKDOWN_TITLE)
    return "markdown";
  return null;
}

/**
 * 语言 → 扩展名。只覆盖常见几种，其余一律回落语言名本身
 * （`rust` / `go` 这类本来就同名，白名单维护起来不划算）。
 */
export function languageExtension(
  language: string
): string {
  const map: Record<string, string> = {
    bash: "sh",
    sh: "sh",
    shell: "sh",
    zsh: "sh",
    console: "txt",
    text: "txt",
    txt: "txt",
    plaintext: "txt",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    python: "py",
    py: "py",
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    html: "html",
    css: "css",
    sql: "sql",
    md: "md",
    markdown: "md",
    diff: "patch",
    patch: "patch"
  };
  const key = language.trim().toLowerCase();
  return map[key] ?? key;
}

/** 代码块容器 → 文件名（Streamdown 自己也是「`file` + 扩展名」）。 */
export function codeBlockFileName(
  language: string
): string {
  const ext = languageExtension(language);
  return ext ? `file.${ext}` : "file.txt";
}

/** 表格 → 文件名。 */
export function tableFileName(
  format: TableFormat
): string {
  return `${TABLE_BASE_NAME}.${format === "csv" ? "csv" : "md"}`;
}

/**
 * 从点击目标往上定位表格，取出「文件名 + 序列化后的正文」。
 *
 * 复用 Streamdown **导出的** `extractTableDataFromElement` /
 * `tableDataToCSV` / `tableDataToMarkdown` —— 自己重写一遍转义规则
 * （引号翻倍、竖线转义、换行转 `<br>`）迟早和它对不上。
 */
export function readTable(
  target: EventTarget | null,
  format: TableFormat
): { fileName: string; code: string } | null {
  if (!(target instanceof Element)) return null;
  const wrapper = target.closest(
    TABLE_WRAPPER_SELECTOR
  );
  const table = wrapper?.querySelector("table");
  if (!(table instanceof HTMLElement))
    return null;
  const data = extractTableDataFromElement(table);
  // 空表（只有壳没数据）导出来是一份空文件，没必要打扰用户
  if (
    data.headers.length === 0 &&
    data.rows.length === 0
  )
    return null;
  return {
    fileName: tableFileName(format),
    code:
      format === "csv"
        ? tableDataToCSV(data, ",")
        : tableDataToMarkdown(data)
  };
}

/**
 * 在 document 上接管所有导出类按钮。返回清理函数。
 *
 * `onError` 用于把失败文案冒给调用方（面板用它弹错误气泡）——
 * 保存对话框是异步的，捕获阶段拿不到调用栈，只能靠回调。
 */
export function attachStreamdownExport(
  onError: (message: string) => void
): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const button = target?.closest?.("button");
    if (!button) return;

    const format = tableFormatOf(
      button.getAttribute("title")
    );
    if (!format) return;
    const payload = readTable(button, format);
    if (!payload) return;

    // 必须在 Streamdown 的 React onClick 之前拦下来
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    console.info(
      `[ai] 另存为 ${payload.fileName}（${payload.code.length} 字符）`
    );
    invoke<string | null>("fs_save_text_file", {
      content: payload.code,
      suggestedName: payload.fileName
    })
      .then(path => {
        if (path)
          console.info(`[ai] 已保存到 ${path}`);
        else
          console.info("[ai] 用户取消了另存为");
      })
      .catch(reason => {
        console.error("[ai] 另存为失败", reason);
        onError(String(reason));
      });
  };
  document.addEventListener(
    "click",
    onClick,
    true
  );
  return () =>
    document.removeEventListener(
      "click",
      onClick,
      true
    );
}
