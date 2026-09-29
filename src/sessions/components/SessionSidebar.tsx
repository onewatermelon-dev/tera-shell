import type { PointerEvent as ReactPointerEvent } from "react";
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
  /** 拖拽换位：把 id 的会话移到 beforeId 之前，null 表示追加到末尾。 */
  onReorder: (
    id: string,
    beforeId: string | null
  ) => void;
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
  onCreate,
  onReorder
}: Props) {
  const t = useT();

  /**
   * 会话条目拖拽换位（与终端标签同一套 pointer 方案）：按下移动 6px 才算
   * 拖，跟手浮标复用 .tab-drag-ghost；松手按落点元素过不过中线算插入位。
   * 编辑/删除按钮上的按下不算拖 —— 那是按钮自己的事。
   */
  function startSessionDrag(
    event: ReactPointerEvent,
    session: SavedSession
  ) {
    if (event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest(
        "button"
      )
    )
      return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;

    const onMove = (ev: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(
          ev.clientX - startX,
          ev.clientY - startY
        ) > 6
      ) {
        dragging = true;
        document.body.classList.add(
          "tab-dragging"
        );
        ghost = document.createElement("div");
        ghost.className = "tab-drag-ghost";
        ghost.textContent = session.name;
        document.body.appendChild(ghost);
      }
      if (ghost)
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
      ev.preventDefault();
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener(
        "pointermove",
        onMove
      );
      window.removeEventListener(
        "pointerup",
        onUp
      );
      ghost?.remove();
      document.body.classList.remove(
        "tab-dragging"
      );
      if (!dragging) return;
      // 拖拽结束抑制尾随 click：避免落点上的元素被误点
      ev.preventDefault();
      // elementFromPoint 拿落点元素（被拖项跟着指针走，不能用 ev.target）
      const under = document.elementFromPoint(
        ev.clientX,
        ev.clientY
      );
      const el = under?.closest(
        "[data-session-id]"
      ) as HTMLElement | null;
      if (!el) return;
      const targetId = el.getAttribute(
        "data-session-id"
      );
      if (!targetId || targetId === session.id)
        return;
      // 指针过中线就插到它后面（取它下面那个会话当锚点，没有就是末尾）
      const items = [
        ...document.querySelectorAll(
          "[data-session-id]"
        )
      ];
      const index = items.indexOf(el);
      const after =
        ev.clientY >
        el.getBoundingClientRect().top +
          el.getBoundingClientRect().height / 2;
      const beforeId = after
        ? ((
            items[index + 1] as
              HTMLElement | undefined
          )?.getAttribute("data-session-id") ??
          null)
        : targetId;
      if (beforeId !== session.id)
        onReorder(session.id, beforeId);
    };
    window.addEventListener(
      "pointermove",
      onMove
    );
    window.addEventListener("pointerup", onUp);
  }

  return (
    // aside 保留 complementary 语义；面板底色/描边/圆角走 .sidebar（HeroUI token）。
    // 收起/展开的开关在左侧竖条（AppRail）上，这里只负责展开态的内容。
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
              data-session-id={session.id}
              onPointerDown={event =>
                startSessionDrag(event, session)
              }
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
