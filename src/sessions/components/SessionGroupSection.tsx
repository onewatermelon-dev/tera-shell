import {
  useEffect,
  useRef,
  useState
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import {
  RightOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  LinkOutlined,
  DashboardOutlined,
  DesktopOutlined,
  SafetyCertificateOutlined
} from "@ant-design/icons";
import type { SavedSession } from "@/sessions/lib/session";
import {
  generateTotp,
  totpRemaining
} from "@/sessions/lib/totp";
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
  /** 打开该会话的值守巡检配置 */
  onWatch: (session: SavedSession) => void;
  /** 打开该会话的远程桌面（起隧道 + 拉客户端） */
  onRemoteDesktop: (
    session: SavedSession
  ) => void;
};

/** 单个会话条目。抽成独立组件，让父级只管分组结构。 */
function SessionRow({
  session,
  activeId,
  groupId,
  onPointerDown,
  onDoubleClick,
  onEdit,
  onRemove,
  onWatch,
  onRemoteDesktop
}: {
  session: SavedSession;
  activeId: string;
  groupId: string;
  onPointerDown: Props["onSessionPointerDown"];
  onDoubleClick: Props["onSessionDoubleClick"];
  onEdit: Props["onEdit"];
  onRemove: Props["onRemove"];
  onWatch: Props["onWatch"];
  onRemoteDesktop: Props["onRemoteDesktop"];
}) {
  const t = useT();
  /**
   * TOTP 验证码浮条。ok 态展示 6 位码 + 剩余秒数（每秒递减，
   * 到 1 秒即关 —— 码马上要过期，留着只会让人抄到旧码）；
   * error 态展示失败原因，4 秒自关。
   */
  const [chip, setChip] = useState<
    | {
        kind: "ok";
        code: string;
        remaining: number;
      }
    | { kind: "error"; message: string }
    | null
  >(null);
  // 解密一次（DPAPI invoke），浮条存活期内复用明文密钥
  const plainRef = useRef<string | null>(null);

  /** 算当前码 → 复制到剪贴板 → 弹浮条。再点浮条上的码可重拷新窗口的码。 */
  async function copyTotp() {
    if (!session.totpSecret) return;
    try {
      if (!plainRef.current) {
        plainRef.current = await invoke<string>(
          "decrypt",
          { encoded: session.totpSecret }
        );
      }
      const code = await generateTotp(
        plainRef.current
      );
      await navigator.clipboard.writeText(code);
      setChip({
        kind: "ok",
        code,
        remaining: totpRemaining()
      });
    } catch (reason) {
      console.error(
        "[sidebar] 生成/复制 TOTP 验证码失败：",
        reason
      );
      setChip({
        kind: "error",
        message: `${t("totp.error")}${String(reason)}`
      });
    }
  }

  // 浮条倒计时 / 错误自关：一条 effect 走完，不引外部定时器。
  // 关闭动作全在定时器回调里做（函数式更新顺带防旧闭包），effect 体
  // 不同步 setState —— react-hooks/set-state-in-effect 会拦
  useEffect(() => {
    if (!chip) return;
    if (chip.kind === "error") {
      const timer = setTimeout(
        () => setChip(null),
        4000
      );
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(
      () =>
        setChip(prev => {
          if (!prev || prev.kind !== "ok")
            return null;
          // 剩 1 秒即码将过期，直接关掉，不留旧码给人抄
          return prev.remaining <= 1
            ? null
            : {
                ...prev,
                remaining: prev.remaining - 1
              };
        }),
      1000
    );
    return () => clearTimeout(timer);
  }, [chip]);

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
          className="watch"
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={t("sidebar.remoteDesktop")}
          onPress={() => onRemoteDesktop(session)}
        >
          <DesktopOutlined />
        </Button>
      )}
      {session.id !== "local" && (
        <Button
          className="watch"
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={t("sidebar.watch")}
          onPress={() => onWatch(session)}
        >
          <DashboardOutlined />
        </Button>
      )}
      {session.totpSecret && (
        <Button
          className="totp"
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={t("sidebar.totp")}
          onPress={copyTotp}
        >
          <SafetyCertificateOutlined />
        </Button>
      )}
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
      {chip && (
        <div
          className={`totp-chip${chip.kind === "error" ? " is-error" : ""}`}
          role="status"
        >
          {chip.kind === "ok" ? (
            <>
              <button
                type="button"
                className="totp-code"
                onClick={copyTotp}
                title={t("sidebar.totp")}
              >
                {chip.code}
              </button>
              <small>{chip.remaining}s</small>
            </>
          ) : (
            <small>{chip.message}</small>
          )}
          <button
            type="button"
            className="totp-close"
            aria-label={t("app.action.close")}
            onClick={() => setChip(null)}
          >
            ×
          </button>
        </div>
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
  onRemove,
  onWatch,
  onRemoteDesktop
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
              onWatch={onWatch}
              onRemoteDesktop={onRemoteDesktop}
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
