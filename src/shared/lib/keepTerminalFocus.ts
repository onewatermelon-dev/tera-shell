/**
 * 侧栏 / 竖条等终端旁容器的焦点保持。
 *
 * 点击这些容器的空白处时，浏览器默认会把焦点从终端挪走，光标停止
 * 闪烁、敲键无响应。在容器的 onMouseDown 上挂本函数：按下的目标若是
 * 交互元素（按钮 / 链接 / 输入框等）则放行（它们本来就要收焦点），
 * 否则阻止 mousedown 的默认行为 —— click 照常触发，终端焦点不动。
 */
export function keepTerminalFocus(event: {
  target: unknown;
  preventDefault(): void;
}): void {
  const target =
    event.target as HTMLElement | null;
  if (
    target?.closest?.(
      "button, a, input, textarea, select, [role='menuitem'], [aria-haspopup]"
    )
  )
    return;
  event.preventDefault();
}

/**
 * 菜单 / 开关动作后的焦点回还：这类动作的按钮焦点留在竖条上，而动作
 * 本身（复制粘贴、收起会话栏、切换状态栏等）几乎都是针对终端的 —— 若
 * 焦点还留在竖条按钮或 body 上，就把它还给终端；用户已被导向别处
 * （搜索框、对话框、设置页）则不打扰。
 *
 * 竖条菜单/浮层带退出动画，RAC 要等动画结束才把焦点还给触发按钮，
 * 所以这里用短轮询持续校正（动画期间的恢复会先落回按钮，下一拍再被
 * 抢回终端）；一旦焦点去了别的交互元素说明用户有自己的去向，立即收手。
 */
export function refocusAfterAction(
  focus: () => void
): void {
  const attempt = () => {
    if (
      document.querySelector(
        ".settings-page, [role='dialog']"
      )
    )
      return;
    const el = document.activeElement;
    const idle =
      !el ||
      el === document.body ||
      (el instanceof HTMLElement &&
        !!el.closest(".app-rail"));
    if (idle) focus();
  };
  for (const delay of [50, 150, 300, 500, 750]) {
    setTimeout(attempt, delay);
  }
}
