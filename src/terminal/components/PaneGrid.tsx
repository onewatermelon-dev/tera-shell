import {
  useCallback,
  type ReactNode
} from "react";
import type {
  PaneNode,
  SplitDirection
} from "@/terminal/lib/paneLayout";
import {
  MIN_RATIO,
  MAX_RATIO
} from "@/terminal/lib/paneLayout";

type Props = {
  node: PaneNode;
  /** 渲染一个叶子窗格的内容（标签条 + 宿主由调用方决定） */
  renderLeaf: (paneId: string) => ReactNode;
  /** 拖分隔条写回比例 */
  onRatio: (
    splitId: string,
    ratio: number
  ) => void;
};

/** 分隔条厚度（px）：比例计算要扣掉它，与 flex 权重分配保持一致。 */
const DIVIDER = 4;

/**
 * 递归渲染窗格布局树。
 *
 * - 叶子：一个窗格，内容交给 renderLeaf
 * - 分割：一层 flex 容器 + 中间一条可拖的分隔条
 *
 * 两种方向的差别只有两点：`flex-direction` 与分隔条的宽/高、光标形状。
 * 其余（比例 → flex 权重的映射）完全一致，所以合并成同一段代码。
 */
export default function PaneGrid({
  node,
  renderLeaf,
  onRatio
}: Props) {
  /**
   * 拖分隔条：pointermove 全局监听，按容器尺寸算比例，钳在
   * MIN_RATIO~MAX_RATIO；松手后容器尺寸变化由上层 ResizeObserver
   * 感知，各窗格终端会各自重新 fit。
   */
  const startDrag = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      splitId: string,
      direction: SplitDirection
    ) => {
      event.preventDefault();
      const container =
        event.currentTarget.parentElement;
      if (!container) return;
      const vertical = direction === "row";
      const onMove = (ev: PointerEvent) => {
        const rect =
          container.getBoundingClientRect();
        // 比例按「总长扣除分隔条」计算，与两块的 flex 权重
        // （basis 0%，剩余空间按权重分）保持一致
        const usable = Math.max(
          1,
          (vertical ? rect.width : rect.height) -
            DIVIDER
        );
        const ratio = vertical
          ? (ev.clientX - rect.left) / usable
          : (ev.clientY - rect.top) / usable;
        onRatio(
          splitId,
          Math.min(
            MAX_RATIO,
            Math.max(MIN_RATIO, ratio)
          )
        );
      };
      const onUp = () => {
        window.removeEventListener(
          "pointermove",
          onMove
        );
        window.removeEventListener(
          "pointerup",
          onUp
        );
      };
      window.addEventListener(
        "pointermove",
        onMove
      );
      window.addEventListener("pointerup", onUp);
    },
    [onRatio]
  );

  if (node.kind === "leaf") {
    return <>{renderLeaf(node.paneId)}</>;
  }

  return (
    <div
      className={`pane-split pane-split--${node.direction}`}
      data-split-id={node.id}
    >
      <div
        className="pane-split-side"
        style={{ flex: `${node.ratio} 1 0%` }}
      >
        <PaneGrid
          node={node.first}
          renderLeaf={renderLeaf}
          onRatio={onRatio}
        />
      </div>
      {/* 分隔条：拖动调整两块的比例（VSCode 式），悬停高亮 */}
      <div
        className={`pane-divider pane-divider--${node.direction}`}
        onPointerDown={event =>
          startDrag(
            event,
            node.id,
            node.direction
          )
        }
      ></div>
      <div
        className="pane-split-side"
        style={{ flex: `${1 - node.ratio} 1 0%` }}
      >
        <PaneGrid
          node={node.second}
          renderLeaf={renderLeaf}
          onRatio={onRatio}
        />
      </div>
    </div>
  );
}
