import type { ReactNode } from "react";
import { Tooltip } from "@heroui/react";

type Props = {
  /** 提示内容；可以是字符串或带排版的 ReactNode */
  label: ReactNode;
  /**
   * 提示的弹出方向。
   *
   * 默认向下，但**靠近窗口底部的元素必须传 "top"** —— 例如状态栏里的
   * 快捷宏按钮：向下弹会跑到窗口外面，看起来像卡在左下角不走。
   */
  placement?:
    | "top"
    | "bottom"
    | "left"
    | "right"
    | "bottom left";
  /** 追加到提示气泡的类名（如多行文案的 pre-line） */
  className?: string;
  children: ReactNode;
};

/** 图标按钮悬浮提示：HeroUI Tooltip（trigger + content）复用封装。 */
export default function Hint({
  label,
  placement = "bottom",
  className,
  children
}: Props) {
  return (
    <Tooltip delay={400}>
      {children}
      <Tooltip.Content
        className={className}
        placement={placement}
        offset={4}
      >
        <Tooltip.Arrow />
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}
