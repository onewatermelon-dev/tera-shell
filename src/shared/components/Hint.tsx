import type { ReactNode } from "react";
import { Tooltip } from "@heroui/react";

type Props = {
  label: string;
  children: ReactNode;
};

/** 图标按钮悬浮提示：HeroUI Tooltip（trigger + content）复用封装。 */
export default function Hint({
  label,
  children
}: Props) {
  return (
    <Tooltip delay={400}>
      {children}
      <Tooltip.Content
        placement="bottom"
        offset={4}
      >
        <Tooltip.Arrow />
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}
