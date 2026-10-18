import type {
  CSSProperties,
  ReactNode
} from "react";
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
  /**
   * 追加到触发层的类名。
   *
   * 触发层是 Tooltip.Trigger 渲染的 div（不是 children 本身），当被
   * 提示的元素需要参与父级 flex 布局（如 `flex: 1` + 截断的路径文本）
   * 时，尺寸约束必须落在这层上，否则 span 的 flex 约束不生效。
   */
  triggerClassName?: string;
  /**
   * 气泡的内联样式。
   *
   * 需要**压过 HeroUI 默认类**时用它（内联样式优先级高于任何 class，
   * 包括工具类合并后的结果）—— 典型场景：把气泡宽度限制在父容器
   * （如 AI 面板）内，别让它飘出容器边缘。
   */
  contentStyle?: CSSProperties;
  children: ReactNode;
};

/** 图标按钮悬浮提示：HeroUI Tooltip（trigger + content）复用封装。 */
export default function Hint({
  label,
  placement = "bottom",
  className,
  triggerClassName,
  contentStyle,
  children
}: Props) {
  return (
    <Tooltip delay={400}>
      {/* 必须显式包 Tooltip.Trigger：RAC 的触发 props 走 FocusableContext，
          没有 Trigger 层接收 hover/focus，气泡永远不会弹出 */}
      <Tooltip.Trigger
        className={triggerClassName}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content
        className={className}
        placement={placement}
        offset={4}
        style={contentStyle}
      >
        <Tooltip.Arrow />
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}
