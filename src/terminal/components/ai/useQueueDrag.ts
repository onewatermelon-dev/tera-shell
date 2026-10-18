/**
 * 排队消息的拖拽换序。
 *
 * 从 AiPanel.tsx 拆出（2026-10-13）。状态放在 hook 里（而不是每行
 * 自己管）是因为「谁在被拖」和「谁是落点」跨行共享 —— 各自管会各拖各的。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AiQueuedMessage } from "@/terminal/lib/ai/aiChat";

export function useQueueDrag(
  queued: AiQueuedMessage[],
  reorderQueued: (
    id: string,
    targetId: string
  ) => void
) {
  const [dragId, setDragId] = useState<
    string | null
  >(null);
  const [dropId, setDropId] = useState<
    string | null
  >(null);
  // pointermove 是普通函数，不在 React 渲染期里，闭包拿到的 state 永远
  // 是按下那一刻的值。落点每帧都要读最新的队列（判断"移到队尾"），
  // 所以走 ref；dropId 同理，用 ref 存一份给收尾逻辑读。
  const queuedRef = useRef(queued);
  const dropIdRef = useRef<string | null>(null);
  useEffect(() => {
    queuedRef.current = queued;
  }, [queued]);

  /**
   * 在手柄上按下 → 可能演变成一次拖拽。
   *
   * 整段照搬会话侧栏「拖标签换组」的成熟做法（那边在 WebView2 里已验证
   * 能用），刻意**不用** HTML5 的 draggable/dragover/drop：那套依赖浏览器
   * 内置拖拽管线与 dataTransfer，在 Tauri 的 WebView2 里实测完全拖不动，
   * 而且不报错、控制台干净，是最难查的一类问题。
   *
   * pointer 方案的三要素：
   * ① `pointermove`/`pointerup` 挂 **window** —— 指针移出列表外仍能收到，
   *    否则拖到边缘松手就"卡住不落了"；
   * ② 越过 6px 位移阈值才算拖动，纯点击手柄不会误触发；
   * ③ 落点用 `elementFromPoint` 取 —— 被拖的行跟着指针走，不能用
   *    `event.target`。
   */
  const startQueueDrag = useCallback(
    (
      id: string,
      event: ReactPointerEvent<HTMLSpanElement>
    ) => {
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let ghost: HTMLElement | null = null;
      const text = queued.find(
        item => item.id === id
      )?.text;
      /**
       * 落点命中**原始** id（可能等于自己，可能 null=缝隙）。
       *
       * 别拿高亮用的 dropIdRef 代替：那份在"落回自己身上"时被置成 null，
       * 与"落在缝隙"混成同一个值 —— 收尾时就会把"原地不动"误判成
       * "移到队尾"，用户只是手滑一下，队列就变了。三种状态必须分开存：
       * 命中自己=不动，命中别的=换过去，null=移到队尾。
       */
      let hitRef: string | null = null;

      // 局部监听刻意不叫 onMove：props 里已有同名回调会遮蔽它
      const onDragMove = (ev: PointerEvent) => {
        if (
          !dragging &&
          Math.hypot(
            ev.clientX - startX,
            ev.clientY - startY
          ) > 6
        ) {
          dragging = true;
          setDragId(id);
          ghost = document.createElement("div");
          ghost.className = "ai-queue-drag-ghost";
          // 超长消息只留开头，否则浮标能撑破整个面板
          ghost.textContent =
            (text ?? "").slice(0, 40) +
            ((text ?? "").length > 40 ? "…" : "");
          document.body.appendChild(ghost);
          // 全局 grabbing：指针移出手柄后光标不该变回去
          document.body.classList.add(
            "ai-queue-dragging"
          );
          console.info(
            `[ai] 队列开始拖动：${id}`
          );
        }
        if (!ghost) return;
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
        const under = document.elementFromPoint(
          ev.clientX,
          ev.clientY
        );
        const row = (
          under as HTMLElement | null
        )?.closest(
          ".ai-queue-row"
        ) as HTMLElement | null;
        const hitId =
          row?.getAttribute("data-queued-id") ??
          null;
        hitRef = hitId;
        // 落回自己身上 = 不动。高亮也要跟着取消，用户才能明确知道
        // 「松手不会有变化」，而不是白闪一下
        const next = hitId === id ? null : hitId;
        if (next !== dropIdRef.current) {
          dropIdRef.current = next;
          setDropId(next);
        }
        ev.preventDefault();
      };

      const onDragEnd = (ev: PointerEvent) => {
        window.removeEventListener(
          "pointermove",
          onDragMove
        );
        window.removeEventListener(
          "pointerup",
          onDragEnd
        );
        ghost?.remove();
        document.body.classList.remove(
          "ai-queue-dragging"
        );
        if (!dragging) return;
        // 松手后不要顺带触发 click，否则落点行的操作按钮会被误点
        ev.preventDefault();
        const list = queuedRef.current;
        // 三态判定，顺序不能换：先排除"落回自己"，再谈缝隙
        const target =
          hitRef === id
            ? null
            : (hitRef ??
              list[list.length - 1]?.id ??
              null);
        if (target) reorderQueued(id, target);
        console.info(
          `[ai] 队列拖放完成：${id} → ${
            target ?? "(原地不动)"
          }`
        );
        hitRef = null;
        dropIdRef.current = null;
        setDropId(null);
        setDragId(null);
      };

      window.addEventListener(
        "pointermove",
        onDragMove
      );
      window.addEventListener(
        "pointerup",
        onDragEnd
      );
    },
    [queued, reorderQueued]
  );

  return { dragId, dropId, startQueueDrag };
}
