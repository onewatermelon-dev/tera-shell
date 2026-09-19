import type { SavedSession } from "@/sessions/lib/session";
import {
  Button,
  Header,
  Input,
  ListBox,
  TextField
} from "@heroui/react";
import Hint from "@/shared/components/Hint";
import { useT } from "@/settings/lib/i18n";
import {
  PlusOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  EditOutlined,
  DeleteOutlined
} from "@ant-design/icons";

type Props = {
  sessions: SavedSession[];
  activeId: string;
  openedCount: number;
  query: string;
  onQueryChange: (value: string) => void;
  onDuplicate: (session: SavedSession) => void;
  onEdit: (session: SavedSession) => void;
  onRemove: (id: string) => void;
  onCreate: () => void;
};

export default function SessionSidebar({
  sessions,
  activeId,
  openedCount,
  query,
  onQueryChange,
  onDuplicate,
  onEdit,
  onRemove,
  onCreate
}: Props) {
  const t = useT();
  return (
    // aside 保留 complementary 语义；面板底色/描边/圆角走 .sidebar（HeroUI token）
    <aside className="sidebar">
      <Header className="sidebar-head">
        <div>
          <span>{t("sidebar.title")}</span>
          <small>{sessions.length}</small>
        </div>
        <Hint label={t("sidebar.newSsh")}>
          <Button
            size="sm"
            isIconOnly
            aria-label={t("sidebar.newSsh")}
            onPress={onCreate}
          >
            <PlusOutlined />
          </Button>
        </Hint>
      </Header>
      <TextField
        className="search-box"
        aria-label={t(
          "sidebar.searchPlaceholder"
        )}
        value={query}
        onChange={onQueryChange}
      >
        <SearchOutlined />
        <Input
          placeholder={t(
            "sidebar.searchPlaceholder"
          )}
        />
      </TextField>
      <div className="group-title">
        <span>{t("sidebar.mine")}</span>
        <FolderOpenOutlined />
      </div>
      {sessions.length ? (
        <ListBox
          aria-label={t("sidebar.mine")}
          className="session-list"
          // 受控单选：高亮跟随 activeId（已打开标签），点击不改变选中
          selectionMode="single"
          selectedKeys={
            activeId ? [activeId] : []
          }
          onSelectionChange={() => {}}
        >
          {sessions.map(session => (
            <ListBox.Item
              key={session.id}
              id={session.id}
              // RAC 无障碍：复合内容项需提供纯文本值（type-to-select）
              textValue={session.name}
              className="session-item"
              onDoubleClick={() =>
                onDuplicate(session)
              }
            >
              <span className="session-icon">
                <LinkOutlined />
              </span>
              <span className="session-copy">
                <strong>{session.name}</strong>
                <small>
                  {session.kind === "local"
                    ? t("sidebar.localTerminal")
                    : `${session.username ? session.username + "@" : ""}${session.host}:${session.port}`}
                </small>
              </span>
              {session.id !== "local" && (
                <Button
                  className="edit"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={t("sidebar.edit")}
                  onPress={() => onEdit(session)}
                >
                  <EditOutlined />
                </Button>
              )}
              {session.id !== "local" && (
                <Button
                  className="delete"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={t("sidebar.remove")}
                  onPress={() =>
                    onRemove(session.id)
                  }
                >
                  <DeleteOutlined />
                </Button>
              )}
            </ListBox.Item>
          ))}
        </ListBox>
      ) : (
        <p className="empty-list">
          {t("sidebar.noMatch")}
        </p>
      )}
      <div className="sidebar-foot">
        <span className="status-dot"></span>
        <span>{t("sidebar.ready")}</span>
        <small>
          {t("sidebar.connections", {
            count: openedCount
          })}
        </small>
      </div>
    </aside>
  );
}
