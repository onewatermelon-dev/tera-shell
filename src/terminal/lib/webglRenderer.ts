import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * WebGL 渲染器（硬件加速）。
 *
 * xterm 默认的 DOM 渲染器为每个字符生成一个 `<span>`，一万行输出就是
 * 几万次 DOM 变更 —— `ls`、编译日志、`tail -f` 这类输出量大时滚动和
 * 输入都会明显发涩。WebGL 渲染器把字形画进 GPU 纹理，DOM 只保留一个
 * `<canvas>`，性能差一个量级。
 *
 * ## 为什么必须在 open() 之后加载
 *
 * `WebglAddon.activate()` 内部要往 `terminal.screenElement` 里塞 canvas，
 * 而 `screenElement` 是 `open()` 时才创建的。提前 `loadAddon` 会拿到
 * undefined 并抛错。
 *
 * ## 为什么必须处理上下文丢失
 *
 * 显卡驱动重置、系统休眠唤醒、笔记本切换独显/核显都可能让浏览器丢掉
 * WebGL context。此时 canvas 停止渲染但**不抛异常** —— 表现是终端
 * 「一片空白但所有交互正常」，不看控制台根本发现不了。所以必须监听
 * `onContextLoss` 并 dispose 降级回 DOM 渲染器。
 *
 * 另有一条更隐蔽的坑：**每个窗格一个 WebGL context 有上限**
 * （Chromium 通常 16 个），超了之后新的终端会拿不到 context。本项目
 * 最多 4 个 pane 远不到上限，但保留降级路径以防将来改布局。
 */

/**
 * 按终端实例跟踪已启用的 addon。
 *
 * ⚠️ **必须按实例存，不能用单个模块级变量**：本项目是多窗格布局，
 * 同一时刻有多只终端（实测最多 4 个 pane）。单个变量会让第 2 只终端
 * 的启用判定「看到第 1 只已启用」→ 直接 return，等于后面的终端
 * 全都跑不上 WebGL（而且不报错，只是安静地没生效）。
 *
 * WeakMap：终端 dispose 后条目随之回收，不需要手动清理键。
 */
const webglByTerminal = new WeakMap<
  Terminal,
  WebglAddon
>();

/** 降级次数：仅用于日志排查「有几只终端没跑上 WebGL」。 */
let degradedCount = 0;

/**
 * 给已 open() 的终端启用 WebGL 渲染器。
 *
 * 失败**静默降级**而不是抛错：WebGL 是纯优化，显卡不支持、驱动有问题、
 * context 配额满了都该让终端照常能用，只是少一层加速。为此失败只记
 * 日志（用户可见效果是「没那么流畅」，不该弹错误气泡）。
 *
 * 重复调用安全：已启用的终端直接返回。二次 `loadAddon` 会再建一个
 * canvas，旧的不销毁 → 屏幕上叠两层画面，且两边内容可能不同步。
 *
 * @param terminal 已调用过 `open()` 的终端实例
 */
export function enableWebgl(
  terminal: Terminal
): void {
  if (webglByTerminal.has(terminal)) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      // context 已丢，addon 内部状态不再可用；dispose 抛错是已知现象，忽略
      try {
        addon.dispose();
      } catch {
        // 忽略
      }
      webglByTerminal.delete(terminal);
      degradedCount += 1;
      console.warn(
        "[terminal] WebGL 上下文丢失，已降级回 DOM 渲染器" +
          `（第 ${degradedCount} 次）`
      );
    });
    terminal.loadAddon(addon);
    webglByTerminal.set(terminal, addon);
  } catch (reason) {
    degradedCount += 1;
    console.warn(
      "[terminal] WebGL 渲染器不可用，保持 DOM 渲染器",
      reason
    );
  }
}

/** 关闭 WebGL（终端 dispose 前调用，让 GPU 资源及时释放）。 */
export function disableWebgl(
  terminal: Terminal
): void {
  const addon = webglByTerminal.get(terminal);
  if (!addon) return;
  webglByTerminal.delete(terminal);
  try {
    addon.dispose();
  } catch {
    // 已 dispose / context 已丢时再 dispose 会抛，忽略即可
  }
}

/** 该终端当前是否跑在 WebGL 上（自检用）。 */
export function isWebglActive(
  terminal: Terminal
): boolean {
  return webglByTerminal.has(terminal);
}
