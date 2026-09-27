import { useT } from "@/settings/lib/i18n";
import styles from "./ThinkingState.module.css";

/**
 * 流式思考中的 shimmer 提示（vendor 自 @aicss/react 的 ThinkingState）。
 *
 * 原组件文案硬编码英文 "Thinking"，这里改走 i18n 跟随语言切换。
 */
export function ThinkingState() {
  const t = useT();
  return (
    <span className={styles.shimmer}>
      {t("ai.thinking")}
    </span>
  );
}
