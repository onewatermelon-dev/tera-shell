import type { ReactNode } from "react";
import { Tooltip } from "@heroui/react";

type Props = {
  label: string;
  /**
   * 提示的弹出方向。
   *
   * 默认向下，但**靠近窗口底部的元素必须传 "top"** —— 例如状态栏里的
   * 快捷宏按钮：向下弹会跑到窗口外面，看起来像卡在左下角不走。
   */
  placement?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
};

/** 图标按钮悬浮提示：HeroUI Tooltip（trigger + content）复用封装。 */
export default function Hint({
  label,
  placement = "bottom",
  children
}: Props) {
  return (
    <Tooltip delay={400}>
      {children}
      <Tooltip.Content
        placement={placement}
        offset={4}
      >
        <Tooltip.Arrow />
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}
