import { describe, it, expect } from "vitest";
import {
  codeBlockFileName,
  languageExtension,
  tableFileName,
  tableFormatOf,
  CODE_DOWNLOAD_SELECTOR
} from "@/terminal/lib/streamdownExport";
import { defaultTranslations } from "streamdown";

/**
 * Streamdown「导出类」按钮的接管（代码块下载 + 表格下载）。
 *
 * ## 根因：它的下载是纯浏览器实现
 *
 * 内容包成 `Blob` → `createObjectURL` → `<a download>` → `click()`。
 * 普通浏览器弹下载框，但 Tauri 的 **WebView2 没有注册下载处理器**，
 * 请求被**静默丢弃** —— 点按钮什么都不发生，控制台干净。
 *
 * 复制按钮不受影响：它走 `navigator.clipboard`，WebView2 通。
 *
 * ## 表格比代码块多两个坑
 *
 * ① 表格的下载按钮**没有 `data-streamdown` 标记**（代码块那个有），
 *    只能靠 `title` 文本认；
 * ② 表格「全屏」模式把整张表 **portal 到 `document.body`**，挂在
 *    AI 面板元素上的监听器收不到那次点击 —— 症状是「面板里能下载，
 *    一按全屏就又不行了」。所以监听必须挂 `document`。
 *
 * DOM 探测（closest / querySelector）在 node 环境下测不了，所以纯逻辑
 * （文件名推导、菜单项判定）抽出来断言，接线靠源码断言钉住。
 */
describe("Streamdown 导出接管", () => {
  it("语言映射到扩展名", () => {
    expect(languageExtension("bash")).toBe("sh");
    expect(languageExtension("shell")).toBe("sh");
    expect(languageExtension("python")).toBe(
      "py"
    );
    expect(languageExtension("typescript")).toBe(
      "ts"
    );
    expect(languageExtension("JSON")).toBe(
      "json"
    );
  });

  it("未知语言直接用语言名（rust/go 本来就同名）", () => {
    expect(languageExtension("rust")).toBe(
      "rust"
    );
    expect(languageExtension("go")).toBe("go");
    // 大写/空白要归一，别生成 File.RUST
    expect(languageExtension(" Rust ")).toBe(
      "rust"
    );
  });

  it("纯文本类统一给 txt（不生成 file.console）", () => {
    expect(languageExtension("console")).toBe(
      "txt"
    );
    expect(languageExtension("text")).toBe("txt");
  });

  it("空语言回落到 file.txt", () => {
    expect(languageExtension("")).toBe("");
    expect(codeBlockFileName("")).toBe(
      "file.txt"
    );
    expect(codeBlockFileName("bash")).toBe(
      "file.sh"
    );
  });

  it("代码块选择器就是 Streamdown 打的那个标记", () => {
    // ⚠️ 标记名写错整条链路静默失效（点按钮还是没反应），
    // 而 TS / eslint / build 全绿 —— 必须钉死
    expect(CODE_DOWNLOAD_SELECTOR).toBe(
      '[data-streamdown="code-block-download-button"]'
    );
  });

  it("表格下载项按 title 区分 csv / markdown", () => {
    expect(
      tableFormatOf(
        defaultTranslations.downloadTableAsCsv
      )
    ).toBe("csv");
    expect(
      tableFormatOf(
        defaultTranslations.downloadTableAsMarkdown
      )
    ).toBe("markdown");
  });

  it("非表格下载项返回 null（别误伤复制/全屏按钮）", () => {
    expect(tableFormatOf(null)).toBeNull();
    expect(tableFormatOf(undefined)).toBeNull();
    expect(tableFormatOf("")).toBeNull();
    expect(
      tableFormatOf(defaultTranslations.copyTable)
    ).toBeNull();
    expect(
      tableFormatOf(
        defaultTranslations.viewFullscreen
      )
    ).toBeNull();
    expect(
      tableFormatOf(
        defaultTranslations.downloadFile
      )
    ).toBeNull();
  });

  it("表格文件名带对应扩展名", () => {
    expect(tableFileName("csv")).toBe(
      "table.csv"
    );
    expect(tableFileName("markdown")).toBe(
      "table.md"
    );
  });

  it("监听挂在 document 上（表格全屏是 portal 到 body 的）", async () => {
    const src = (
      await import("@/terminal/lib/streamdownExport?raw")
    ).default;
    expect(
      src,
      "监听挂在别的元素上 —— 表格全屏模式收不到点击"
    ).toMatch(
      /document\.addEventListener\(\s*"click",\s*onClick,\s*true\s*\)/
    );
    // 必须捕获阶段，冒泡阶段太晚（React onClick 已跑完）
    expect(src).toMatch(
      /document\.removeEventListener\(\s*"click",\s*onClick,\s*true\s*\)/
    );
    // 阻断三件套，缺一个 Streamdown 自己的下载还会跑
    expect(src).toMatch(/preventDefault\(\)/);
    expect(src).toMatch(/stopPropagation\(\)/);
    expect(src).toMatch(
      /stopImmediatePropagation\(\)/
    );
  });

  it("复用 Streamdown 导出的表格序列化（别自己重写转义规则）", async () => {
    const src = (
      await import("@/terminal/lib/streamdownExport?raw")
    ).default;
    expect(src).toContain(
      "extractTableDataFromElement"
    );
    expect(src).toContain("tableDataToCSV");
    expect(src).toContain("tableDataToMarkdown");
    // 自己写 CSV 的话，引号翻倍 / 竖线转义 / 换行转 <br> 迟早和它对不上
    expect(src).not.toMatch(/replace\(\s*\/"\/g/);
  });

  it("面板确实挂上了接管", async () => {
    const src = (
      await import("@/terminal/components/AiPanel.tsx?raw")
    ).default;
    expect(src).toContain(
      "attachStreamdownExport"
    );
  });

  it("后端命令已注册", async () => {
    const src = (
      await import("../src-tauri/src/lib.rs?raw")
    ).default;
    expect(src).toContain("fs::save_text_file");
  });
});
