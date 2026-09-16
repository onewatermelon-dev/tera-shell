import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  ILink,
  Terminal
} from "@xterm/xterm";

/**
 * 只识别带有明确协议的 HTTP/HTTPS 地址。
 *
 * 不把裸域名识别为链接，避免终端中的文件名、版本号或命令参数被误判。
 * 排除空白、尖括号和引号，是为了让日志中的 `<https://...>`、`"https://..."`
 * 不会把包裹链接的字符一起交给系统浏览器。
 */
const urlPattern = /https?:\/\/[^\s<>"']+/g;

/**
 * 为 xterm 注册普通文本 URL 识别器。
 *
 * xterm 会在鼠标移动到某一缓冲区行时调用 provideLinks。该函数只扫描当前行，
 * 返回链接在终端缓冲区中的范围、悬停样式和激活行为。
 *
 * @param terminal 需要启用链接交互的 xterm 实例。
 * @param onError  打开系统浏览器失败时使用的统一错误处理函数。
 */
export function registerTerminalLinks(
  terminal: Terminal,
  onError: (reason: unknown) => void
) {
  terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      // xterm 的公开行号从 1 开始，而 getLine() 的数组下标从 0 开始，所以需要减 1。
      // translateToString(true) 会删除行末仅用于填充终端宽度的空格，减少无意义扫描。
      const line = terminal.buffer.active
        .getLine(lineNumber - 1)
        ?.translateToString(true);
      if (!line) return callback(undefined);

      const links: ILink[] = [];
      for (const match of line.matchAll(
        urlPattern
      )) {
        // 句号、逗号和右括号经常紧跟在文章或日志中的 URL 后面，但通常不属于地址本身。
        const text = match[0].replace(
          /[),.;!?]+$/,
          ""
        );

        // JavaScript 字符串下标从 0 开始，xterm 的 IBufferRange 横坐标从 1 开始。
        const start = (match.index ?? 0) + 1;
        links.push({
          text,
          range: {
            start: { x: start, y: lineNumber },
            end: {
              x: start + text.length,
              y: lineNumber
            }
          },
          // 装饰只在鼠标悬停链接范围时显示，由 xterm 负责绘制和清理。
          decorations: {
            pointerCursor: true,
            underline: true
          },
          activate(event) {
            // 普通单击仍交给终端处理；只有 Ctrl+单击才允许启动外部浏览器。
            // URL 来源受上方正则限制，只可能是 http:// 或 https://。
            if (event.ctrlKey)
              openUrl(text).catch(onError);
          }
        });
      }

      // 没有链接时返回 undefined，避免 xterm 创建空的链接装饰对象。
      callback(links.length ? links : undefined);
    }
  });
}
