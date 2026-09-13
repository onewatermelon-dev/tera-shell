import type { SavedSession } from "@/domain/session";
import {
  Button,
  Input,
  ListBox,
  TextField
} from "@heroui/react";
import Hint from "@/components/Hint";
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
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div>
          <span>会话</span>
          <small>{sessions.length}</small>
        </div>
        <Hint label="新建 SSH 会话">
          <Button
            size="sm"
            isIconOnly
            aria-label="新建 SSH 会话"
            onPress={onCreate}
          >
            <PlusOutlined />
          </Button>
        </Hint>
      </div>
      <TextField
        className="search-box"
        aria-label="搜索会话"
        value={query}
        onChange={onQueryChange}
      >
        <SearchOutlined />
        <Input placeholder="搜索会话" />
      </TextField>
      <div className="group-title">
        <span>我的会话</span>
        <FolderOpenOutlined />
      </div>
      {sessions.length ? (
        <ListBox
          aria-label="我的会话"
          className="session-list"
          // 高亮由父级 activeId（已打开标签）驱动，不用 ListBox 自身选中态
          selectionMode="none"
        >
          {sessions.map(session => (
            <ListBox.Item
              key={session.id}
              id={session.id}
              // RAC 无障碍：复合内容项需提供纯文本值（type-to-select）
              textValue={session.name}
              className={`session-item${
                activeId === session.id
                  ? " active"
                  : ""
              }`}
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
                    ? "本机终端"
                    : `${session.username ? session.username + "@" : ""}${session.host}:${session.port}`}
                </small>
              </span>
              {session.id !== "local" && (
                <Button
                  className="edit"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label="编辑"
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
                  aria-label="删除"
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
          没有匹配的会话
        </p>
      )}
      <div className="sidebar-foot">
        <span className="status-dot"></span>
        <span>就绪</span>
        <small>{openedCount} 个连接</small>
      </div>
    </aside>
  );
}
