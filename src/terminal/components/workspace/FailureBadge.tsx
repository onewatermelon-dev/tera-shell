/**
 * 命令失败的角标：「这条挂了，看看？」
 *
 * 只在**用户点它**时才把现场送进 AI 面板 —— 这就是它与「值守」的分界：
 * 事件驱动、不常驻、不烧 token。角标本身只是把「刚发生了一次失败」
 * 这件事显示出来，代价是零。
 *
 * 位置：窗格右下角（不挡提示符与输入行，也不挡标签条）。
 * 生命周期：下一条命令成功、点关闭、或点了诊断，都会让它消失。
 */
import { Button } from "@heroui/react";
import { WarningFilled } from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";

export function FailureBadge({
  command,
  exitCode,
  onDiagnose,
  onDismiss
}: {
  /** 失败的命令原文（悬停时完整显示） */
  command: string;
  exitCode: number;
  onDiagnose: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    // 完整命令可能很长：角标只显示一行，title 放整条命令
    <div
      className="failure-badge"
      title={command}
    >
      <Button
        variant="tertiary"
        size="sm"
        className="failure-badge-main"
        onPress={onDiagnose}
      >
        <WarningFilled className="failure-badge-icon" />
        <span className="failure-badge-text">
          {t("terminal.failure.title", {
            code: String(exitCode)
          })}
        </span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        className="failure-badge-close"
        aria-label={t("app.action.close")}
        onPress={onDismiss}
      >
        ×
      </Button>
    </div>
  );
}
