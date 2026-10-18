/**
 * 没有任何会话时的空状态：主操作新建 SSH 会话，次操作开本地终端。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。
 * HeroUI Surface 做圆形图标底盘：空状态的视觉重心，
 * 比原先裸放的 42px 灰图标更有层次。
 */
import {
  Button,
  EmptyState,
  Surface,
  Typography
} from "@heroui/react";
import {
  PlusOutlined,
  DesktopOutlined,
  LinkOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";

export function EmptyTerminal({
  onCreate,
  onOpenLocal
}: {
  onCreate: () => void;
  /** 打开本地终端：空状态里的次要操作。 */
  onOpenLocal: () => void;
}) {
  const t = useT();
  return (
    <EmptyState
      key="empty"
      className="empty-terminal"
    >
      <Surface className="empty-icon">
        <LinkOutlined />
      </Surface>
      <Typography.Heading
        level={3}
        className="empty-title"
      >
        {t("terminal.emptyTitle")}
      </Typography.Heading>
      <Typography.Paragraph
        size="sm"
        className="empty-desc"
      >
        {t("terminal.emptyDesc")}
      </Typography.Paragraph>
      <div className="empty-actions">
        <Button
          variant="primary"
          size="sm"
          onPress={onCreate}
        >
          <PlusOutlined />
          {t("terminal.newTab")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={onOpenLocal}
        >
          <DesktopOutlined />
          {t("app.menu.openLocal")}
        </Button>
      </div>
    </EmptyState>
  );
}
