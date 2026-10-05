import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import {
  useLocale,
  useT
} from "@/settings/lib/i18n";
import styles from "./ChatMessageActions.module.css";

/** 按 aicss MessageActions 的相对时间规则显示，并跟随界面语言。 */
export function formatMessageAge(
  date: Date,
  now: number,
  locale: "zh-CN" | "en-US"
): string {
  const minutes = Math.max(
    0,
    Math.round((now - date.getTime()) / 60000)
  );
  if (minutes < 1)
    return locale === "zh-CN"
      ? "刚刚"
      : "just now";
  if (minutes < 60)
    return locale === "zh-CN"
      ? `${minutes} 分钟前`
      : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)
    return locale === "zh-CN"
      ? `${hours} 小时前`
      : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return locale === "zh-CN"
    ? `${days} 天前`
    : `${days}d ago`;
}

/** 将气泡中心和底边限制在 AI 面板的可见矩形内。 */
export function positionMessageTip(
  anchor: {
    left: number;
    top: number;
    width: number;
  },
  panel: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  },
  size: { width: number; height: number }
): { x: number; y: number } {
  const inset = 8;
  const minX =
    panel.left + inset + size.width / 2;
  const maxX =
    panel.right - inset - size.width / 2;
  return {
    x: Math.min(
      Math.max(
        anchor.left + anchor.width / 2,
        minX
      ),
      Math.max(minX, maxX)
    ),
    y: Math.min(
      Math.max(
        anchor.top - 6,
        panel.top + inset + size.height
      ),
      panel.bottom - inset
    )
  };
}

/** 改造自 aicss MessageActions：为用户与助手消息显示复制和时间。 */
export function ChatMessageActions({
  text,
  sentAt,
  align = "end"
}: {
  text: string;
  sentAt?: number;
  align?: "start" | "end";
}) {
  const t = useT();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() =>
    Date.now()
  );
  const [date] = useState(
    () => new Date(sentAt ?? Date.now())
  );
  const tipId = useId();
  const copyRef = useRef<HTMLButtonElement>(null);
  const timeRef = useRef<HTMLTimeElement>(null);
  const gaugeRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{
    kind: "copy" | "time";
    x: number;
    y: number;
    width: number;
    theme: string;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      60_000
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(
      () => setCopied(false),
      900
    );
    return () => window.clearTimeout(timer);
  }, [copied]);

  /** 复制消息文本；失败时保持原按钮状态。 */
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (reason) {
      console.error("[ai] 复制消息失败", reason);
    }
  }

  const absolute = date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  const label = t(
    copied
      ? "ai.message.copied"
      : "ai.message.copy"
  );

  /** 把组件式提示气泡定位到当前操作上方。 */
  const showTip = useCallback(
    (
      kind: "copy" | "time",
      anchor: HTMLElement
    ) => {
      const rect = anchor.getBoundingClientRect();
      const gauge = gaugeRef.current;
      if (!gauge) return;
      gauge.textContent =
        kind === "copy" ? label : absolute;
      const width = Math.ceil(
        gauge.offsetWidth + 10
      );
      const height = Math.ceil(
        gauge.offsetHeight + 8
      );
      const panel = anchor
        .closest(".ai-panel")
        ?.getBoundingClientRect();
      const point = panel
        ? positionMessageTip(rect, panel, {
            width,
            height
          })
        : {
            x: rect.left + rect.width / 2,
            y: rect.top - 6
          };
      setTip({
        kind,
        x: Math.round(point.x),
        y: Math.round(point.y),
        width,
        theme:
          anchor
            .closest("[data-theme]")
            ?.getAttribute("data-theme") ??
          "light"
      });
    },
    [label, absolute]
  );

  const tipKind = tip?.kind;
  useEffect(() => {
    if (!tipKind) return;
    const follow = () => {
      const anchor =
        tipKind === "copy"
          ? copyRef.current
          : timeRef.current;
      if (anchor) showTip(tipKind, anchor);
    };
    follow();
    window.addEventListener(
      "scroll",
      follow,
      true
    );
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener(
        "scroll",
        follow,
        true
      );
      window.removeEventListener(
        "resize",
        follow
      );
    };
  }, [tipKind, showTip]);

  return (
    <div
      className={styles.root}
      data-align={align}
    >
      <button
        ref={copyRef}
        type="button"
        className={styles.copy}
        aria-label={label}
        aria-describedby={
          tip?.kind === "copy" ? tipId : undefined
        }
        onMouseEnter={event =>
          showTip("copy", event.currentTarget)
        }
        onMouseLeave={() => setTip(null)}
        onFocus={event =>
          showTip("copy", event.currentTarget)
        }
        onBlur={() => setTip(null)}
        onClick={() => void copy()}
      >
        <span
          className={styles.copySwap}
          data-on={copied}
        >
          <svg
            className={`${styles.glyph} ${styles.copyMark}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.125"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect
              width="14"
              height="14"
              x="8"
              y="8"
              rx="2"
              ry="2"
            />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          <svg
            className={`${styles.glyph} ${styles.check}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.125"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 12 9 17 20 6" />
          </svg>
        </span>
      </button>
      <time
        ref={timeRef}
        className={styles.time}
        dateTime={date.toISOString()}
        aria-label={`${t("ai.message.time")} ${absolute}`}
        aria-describedby={
          tip?.kind === "time" ? tipId : undefined
        }
        tabIndex={0}
        onMouseEnter={event =>
          showTip("time", event.currentTarget)
        }
        onMouseLeave={() => setTip(null)}
        onFocus={event =>
          showTip("time", event.currentTarget)
        }
        onBlur={() => setTip(null)}
      >
        {formatMessageAge(date, now, locale)}
      </time>
      {createPortal(
        <>
          <span
            ref={gaugeRef}
            className={styles.tipGauge}
            aria-hidden="true"
          />
          <div
            id={tipId}
            role="tooltip"
            data-theme={tip?.theme}
            data-up={tip ? "true" : undefined}
            className={styles.tip}
            aria-hidden={!tip}
            style={{
              left: tip?.x ?? 0,
              top: tip?.y ?? 0,
              width: tip?.width
            }}
          >
            {tip?.kind === "copy"
              ? label
              : absolute}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
