/**
 * SSH 欢迎卡片：钉在终端区顶部的浮层，手动关闭。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。
 * ConPTY 整屏重绘会抹掉直写 xterm 的内容，欢迎说明只能做在终端
 * 缓冲之外的浮层上 —— 所以它是覆盖层，不是终端里的输出。
 */
import type { OpenSession } from "@/terminal/lib/session/useTerminals";
import { useT } from "@/settings/lib/i18n";

export function WelcomeCard({
  session,
  onClose
}: {
  /** 当前活动的 SSH 会话（卡片展示它的 user@host:port） */
  session: OpenSession;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="term-welcome">
      <button
        type="button"
        className="term-welcome-close"
        aria-label={t("app.action.close")}
        onClick={onClose}
      >
        ×
      </button>
      <p>
        <span className="is-title">
          ✓ Tera Shell 智能终端
        </span>{" "}
        <span className="is-gray">
          AI Edition
        </span>{" "}
        ·{" "}
        <span className="is-red">
          {session.username}@{session.host}:
          {session.port}
        </span>
      </p>
      <p>
        ✓ 直接 SSH 连接 · 独立 exec 执行通道 · AI
        运维助手（右侧面板）
      </p>
      <p>
        ✓ 快捷命令解释：输入「命令/?」回车，如 ls
        -a/?
      </p>
      <p>
        ✓ 系统 / 进程 / 网络信息见底部状态栏 ·
        密码输入不回显
      </p>
      <p className="is-gray">
        💡 内容由 AI 生成，执行前请仔细甄别
      </p>
    </div>
  );
}
