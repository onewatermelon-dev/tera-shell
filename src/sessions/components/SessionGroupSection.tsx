import type { PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@heroui/react";
import {
  RightOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  LinkOutlined
} from "@ant-design/icons";
import type { SavedSession } from "@/sessions/lib/session";
import type {
  SessionGroup,
  SessionGroupView
} from "@/sessions/lib/sessionGroup";
import {
  colorHex,
  UNGROUPED_ATTR
} from "@/sessions/lib/sessionGroup";
import { useT } from "@/settings/lib/i18n";

type Props = {
  view: SessionGroupView;
  /** 该分组的真实元数据；未分组一节为 null（不可重命名 / 不可删）。 */
  group: SessionGroup | null;
  activeId: string;
  /** 搜索进行中：忽略折叠态全部展开，否则搜到的会话可能藏在收起分组里。 */
  searching: boolean;
  onToggle: (id: string) => void;
  onEditGroup: (group: SessionGroup) => void;
  onRemoveGroup: (group: SessionGroup) => void;
  onCreateIn: (groupId: string) => void;
  onSessionPointerDown: (
    event: ReactPointerEvent,
    session: SavedSession
  ) => void;
  onSessionDoubleClick: (
    session: SavedSession
  ) => void;
  onEdit: (session: SavedSession) => void;
  onRemove: (session: SavedSession) => void;
};

/** 单个会话条目。抽成独立组件，让父级只管分组结构。 */
function SessionRow({
  session,
  activeId,
  groupId,
  onPointerDown,
  onDoubleClick,
  onEdit,
  onRemove
}: {
  session: SavedSession;
  activeId: string;
  groupId: string;
  onPointerDown: Props["onSessionPointerDown"];
  onDoubleClick: Props["onSessionDoubleClick"];
  onEdit: Props["onEdit"];
  onRemove: Props["onRemove"];
}) {
  const t = useT();
  return (
    <div
      className="session-item"
      data-session-id={session.id}
      data-group-id={groupId}
      // 活动会话的底色由 .is-active 决定，aria-current 同步给读屏软件
      aria-current={
        session.id === activeId || undefined
      }
      onPointerDown={event =>
        onPointerDown(event, session)
      }
      onDoubleClick={() => onDoubleClick(session)}
    >
      {/* 颜色标记：左侧竖条。空色时不渲染，不留透明占位 */}
      {session.color && (
        <span
          className="session-color"
          style={{
            background: colorHex(session.color)
          }}
        />
      )}
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
          onPress={() => onRemove(session)}
        >
          <DeleteOutlined />
        </Button>
      )}
    </div>
  );
}

/**
 * 侧栏的一个分组节：可折叠标题行 + 组内会话列表。
 *
 * 标题行整行可点（箭头 / 色点 / 名称 / 数量都是热区），
 * 右侧按钮悬停才出现：组内新建、重命名、删除分组。
 * 操作区拦了冒泡 —— 否则点「删除」会顺带把分组折叠掉。
 */
export default function SessionGroupSection({
  view,
  group,
  activeId,
  searching,
  onToggle,
  onEditGroup,
  onRemoveGroup,
  onCreateIn,
  onSessionPointerDown,
  onSessionDoubleClick,
  onEdit,
  onRemove
}: Props) {
  const t = useT();
  // 搜索时强制展开；折叠分组里若有活动会话也展开，否则点不到
  const open =
    searching ||
    view.builtin ||
    !view.collapsed ||
    view.sessions.some(
      session => session.id === activeId
    );

  return (
    <section
      className="session-group"
      // 未分组节用 UNGROUPED_ATTR 占位：空串会让 React 省略整个属性，
      // 拖拽落点就找不到这一节了
      data-group-section={
        view.id || UNGROUPED_ATTR
      }
    >
      <div
        className="group-head"
        {...(view.builtin
          ? {}
          : {
              role: "button",
              tabIndex: 0,
              "aria-expanded": open,
              onClick: () => onToggle(view.id),
              onKeyDown: event => {
                if (
                  event.key === "Enter" ||
                  event.key === " "
                ) {
                  event.preventDefault();
                  onToggle(view.id);
                }
              }
            })}
      >
        {!view.builtin && (
          <RightOutlined
            className={`group-caret${open ? " is-open" : ""}`}
          />
        )}
        {view.color && (
          <span
            className="group-color"
            style={{
              background: colorHex(view.color)
            }}
          />
        )}
        <span className="group-name">
          {view.builtin
            ? t("sidebar.ungrouped")
            : view.name}
        </span>
        <small className="group-count">
          {view.sessions.length}
        </small>
        <span
          className="group-ops"
          onClick={event =>
            event.stopPropagation()
          }
        >
          <Button
            className="group-op"
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={t("group.createIn")}
            onPress={() => onCreateIn(view.id)}
          >
            <PlusOutlined />
          </Button>
          {!view.builtin && group && (
            <>
              <Button
                className="group-op"
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={t("group.rename")}
                onPress={() => onEditGroup(group)}
              >
                <EditOutlined />
              </Button>
              <Button
                className="group-op danger"
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={t("group.remove")}
                onPress={() =>
                  onRemoveGroup(group)
                }
              >
                <DeleteOutlined />
              </Button>
            </>
          )}
        </span>
      </div>
      {open && view.sessions.length > 0 && (
        <div className="session-group-items">
          {view.sessions.map(session => (
            <SessionRow
              key={session.id}
              session={session}
              activeId={activeId}
              groupId={view.id}
              onPointerDown={onSessionPointerDown}
              onDoubleClick={onSessionDoubleClick}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
      {open &&
        view.sessions.length === 0 &&
        !view.builtin && (
          <p className="group-empty">
            {t("group.empty")}
          </p>
        )}
    </section>
  );
}
