"use client";

/** AI 输入框用到的内联 SVG 图标（原组件依赖 lucide-react，已移除）。 */

import type { ReactNode } from "react";
import menuStyles from "./PromptInputMenu.module.css";

/** 菜单行图标统一规格：14px 描边 SVG，固定列宽保证文字对齐。 */
export function MenuSvg({
  children
}: {
  children: ReactNode;
}) {
  return (
    <span className={menuStyles.menuIcon}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </span>
  );
}

/** 上传图片：山景图。 */
export function ImageIcon() {
  return (
    <MenuSvg>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
      />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </MenuSvg>
  );
}

/** 自动执行：播放三角。 */
export function PlayIcon() {
  return (
    <MenuSvg>
      <polygon points="6 3 20 12 6 21 6 3" />
    </MenuSvg>
  );
}

/** 自动应用：带对勾的文件。 */
export function FileCheckIcon() {
  return (
    <MenuSvg>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="m9 15 2 2 4-4" />
    </MenuSvg>
  );
}

/** 菜单行共用的选中对勾图标。 */
export function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
