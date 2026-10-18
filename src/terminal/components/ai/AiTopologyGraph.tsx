"use client";

/**
 * 拓扑关系图卡片：渲染 `metric-chart` 里 `type: "graph"` 的内容。
 *
 * 纵向分层（主机在上、进程在下），同层横向均分。宽度实测后 1:1 绘制，
 * 刻度/标签字号即真实像素（理由同 AiMetricChart）。
 *
 * 节点左侧色条按 kind 区分：host / service / port / process。刻意不做
 * 图例 —— 标题已经说明画的是什么，加图例反而占掉窄面板的空间。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  buildTopologyLayout,
  fitLabel,
  type TopologyKind,
  type TopologySpec
} from "@/terminal/lib/ai/topology";
import styles from "./AiTopologyGraph.module.css";

const FALLBACK_WIDTH = 360;

/** kind → 色条 CSS 类（颜色在 CSS 里绑主题变量）。
 *  ⚠️ 值可能是 undefined：CSS module 的类型声明允许键缺失，
 *  渲染处要 `?? ""` 兜底，否则 class 会渲染成 "undefined"。 */
const KIND_CLASS: Record<
  TopologyKind,
  string | undefined
> = {
  host: styles.kindHost,
  service: styles.kindService,
  port: styles.kindPort,
  process: styles.kindProcess
};

export function AiTopologyGraph({
  spec
}: {
  spec: TopologySpec;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(
    FALLBACK_WIDTH
  );
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const observer = new ResizeObserver(
      entries => {
        const next = Math.round(
          entries[0]?.contentRect.width ?? 0
        );
        if (next > 0) setWidth(next);
      }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => buildTopologyLayout(spec, width),
    [spec, width]
  );

  return (
    <figure className={styles.card} ref={hostRef}>
      <figcaption className={styles.head}>
        <span className={styles.title}>
          {spec.title || "关系图"}
        </span>
        <span className={styles.count}>
          {spec.nodes.length} 节点 /{" "}
          {spec.edges.length} 关系
        </span>
      </figcaption>
      <svg
        className={styles.canvas}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`${spec.title || "关系图"}，${
          spec.nodes.length
        } 个节点`}
      >
        {/* 先画线：压在节点下面，避免遮住文字 */}
        {layout.edges.map(edge => (
          <line
            key={`${edge.from}->${edge.to}`}
            className={styles.edge}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
          />
        ))}
        {layout.nodes.map(node => (
          <g key={node.id}>
            <rect
              className={styles.node}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx="6"
            />
            {/* 左侧色条：种类靠颜色区分，拓扑图里比图标省地方 */}
            <rect
              className={
                KIND_CLASS[node.kind] ?? ""
              }
              x={node.x}
              y={node.y}
              width="3"
              height={node.height}
            />
            <text
              className={styles.label}
              x={node.x + node.width / 2 + 1.5}
              y={node.y + node.height / 2}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {fitLabel(node.label, node.width)}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}
