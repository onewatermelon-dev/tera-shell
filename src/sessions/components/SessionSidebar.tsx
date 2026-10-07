import type { PointerEvent as ReactPointerEvent } from "react";
import { useMemo } from "react";
import type { SavedSession } from "@/sessions/lib/session";
import type { SessionGroup } from "@/sessions/lib/sessionGroup";
import {
  attrToGroupId,
  groupSessions,
  UNGROUPED_ID
} from "@/sessions/lib/sessionGroup";
import {
  Button,
  Header,
  Input,
  TextField
} from "@heroui/react";
import Hint from "@/shared/components/Hint";
import { keepTerminalFocus } from "@/shared/lib/keepTerminalFocus";
import { useT } from "@/settings/lib/i18n";
import {
  PlusOutlined,
  SearchOutlined,
  FolderAddOutlined
} from "@ant-design/icons";
import SessionGroupSection from "@/sessions/components/SessionGroupSection";

type Props = {
  /** 已按搜索词过滤过的会话。 */
  sessions: SavedSession[];
  groups: SessionGroup[];
  activeId: string;
  openedCount: number;
  query: string;
  onQueryChange: (value: string) => void;
  onDuplicate: (session: SavedSession) => void;
  onEdit: (session: SavedSession) => void;
  /**
   * 请求删除会话。传整个会话对象而非 id —— 二次确认弹窗要显示会话名，
   * 拿到 id 得反查，不如直接给。
   */
  onRemove: (session: SavedSession) => void;
  onCreate: () => void;
  onToggleGroup: (id: string) => void;
  /** 新建分组（打开分组弹窗）。 */
  onCreateGroup: () => void;
  onEditGroup: (group: SessionGroup) => void;
  onRemoveGroup: (group: SessionGroup) => void;
  /** 在指定分组里新建会话（分组 id，空串 = 未分组）。 */
  onCreateInGroup: (groupId: string) => void;
  /**
   * 拖拽落位：把 id 的会话移到 beforeId 之前，并归入 groupId。
   * beforeId 为 null 表示放到列表末尾。
   */
  onMove: (
    id: string,
    groupId: string,
    beforeId: string | null
  ) => void;
};

export default function SessionSidebar({
  sessions,
  groups,
  activeId,
  openedCount,
  query,
  onQueryChange,
  onDuplicate,
  onEdit,
  onRemove,
  onCreate,
  onToggleGroup,
  onCreateGroup,
  onEditGroup,
  onRemoveGroup,
  onCreateInGroup,
  onMove
}: Props) {
  const t = useT();
  // 搜索时全部展开：折叠分组里的命中项必须看得见
  const searching = query.trim().length > 0;
  const views = useMemo(
    () => groupSessions(sessions, groups),
    [sessions, groups]
  );
  const groupById = useMemo(
    () => new Map(groups.map(g => [g.id, g])),
    [groups]
  );

  /**
   * 会话条目拖拽（与终端标签同一套 pointer 方案）：按下移动 6px 才算拖，
   * 跟手浮标复用 .tab-drag-ghost；松手按落点过不过中线算插入位。
   * 编辑/删除按钮上的按下不算拖 —— 那是按钮自己的事。
   *
   * 跨组拖拽：落点会话所在的分组就是目标分组，move 会同时改groupId 与位置。
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

    // 局部拖拽监听刻意不叫 onMove：props 里已有一个 onMove（落位回调），
    // 同名会被遮蔽成"移动事件监听"，onMove(...) 调用直接编译不过
    const onDragMove = (ev: MouseEvent) => {
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
    const onDragEnd = (ev: MouseEvent) => {
      window.removeEventListener(
        "pointermove",
        onDragMove
      );
      window.removeEventListener(
        "pointerup",
        onDragEnd
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
      if (!under) return;
      const el = under.closest(
        "[data-session-id]"
      ) as HTMLElement | null;
      // 所在分组节：分组标题行与空分组占位都落在这里，是「把会话拖进这个
      // 分组」最自然的放手处（空分组里根本没有条目可落，只能靠它）
      const section = under.closest(
        "[data-group-section]"
      ) as HTMLElement | null;
      // 属性值可能是未分组占位符（UNGROUPED_ATTR），翻回真正的分组 id
      const sectionGroupId = section
        ? attrToGroupId(
            section.getAttribute(
              "data-group-section"
            )
          )
        : null;
      // 标题行右侧的操作按钮区（新建/重命名/删除）不是落点：拖到那儿
      // 误触发换组比什么都不做更糟。拖拽松手不走 click 路径，
      // 组件里的 stopPropagation 拦不住，只能在这里判
      const onOps = Boolean(
        under.closest(".group-ops")
      );
      // 落在标题行上：前半段（箭头/色点/名称）是落点，后半段计数与
      // 按钮区不是。按 x 位置切一半太脆，直接用「不在 ops 里」判定即可
      const onGroupHead = Boolean(
        under.closest(".group-head")
      );

      /**
       * 落到分组标题行 / 空分组占位：归入该分组，追加到组末。
       *
       * 未分组一节也接受（等价于「从某个分组里拖出来」）；已经在该节的
       * 会话再拖一次什么都不做。
       */
      const dropIntoSection = () => {
        // 判定用 `=== null` 而不是真值：未分组节的 id 是空串，
        // 真值判断会把「拖到未分组节」（=把会话移出分组）一起挡掉
        if (sectionGroupId === null || onOps)
          return false;
        // 当前分组直接取被拖会话自带的 groupId —— 不要去 sessions 里查：
        // 那是搜索过滤后的列表，被拖的会话未必还在里面
        const currentGroupId =
          session.groupId ?? UNGROUPED_ID;
        if (currentGroupId === sectionGroupId)
          return false;
        onMove(session.id, sectionGroupId, null);
        console.debug(
          `[sidebar] 会话 ${session.id} 拖入分组「${sectionGroupId || "未分组"}」（标题行/空分组落点）`
        );
        return true;
      };

      // 落在分组标题行上：标题行内没有任何会话条目，el 必为 null，
      // 所以**必须先于 el 分支判定** —— 早先写成「!el 时若onGroupHead
      // 就 return」，恰好把这条最常见的路径挡掉了，标题行分支成了死代码。
      if (onGroupHead) {
        dropIntoSection();
        return;
      }

      if (!el) {
        // 没落在条目上、也不在标题行：只剩空分组的占位文字，
        // 落在那儿等价于「拖进这个空分组」
        if (!section) return;
        dropIntoSection();
        return;
      }

      const targetId = el.getAttribute(
        "data-session-id"
      );
      if (!targetId || targetId === session.id)
        return;
      // 落点条目所属分组即目标分组
      const targetGroup =
        el.getAttribute("data-group-id") ??
        UNGROUPED_ID;
      // 只取当前可见条目，折叠分组里的会话不参与落点计算
      const items = [
        ...document.querySelectorAll(
          "[data-session-id]"
        )
      ];
      const index = items.indexOf(el);
      const rect = el.getBoundingClientRect();
      const after =
        ev.clientY > rect.top + rect.height / 2;
      // 「插到它后面」时，取下一个条目当锚点。
      // ⚠️ 必须校验锚点与落点同组：可见条目是按节分块排列的，下一个
      // 条目很可能属于**下一个分组**（落点是本组最后一条时）。拿跨组条目
      // 当锚点会把会话插到隔壁组里，看起来就是「拖不进分组 / 拖错组」。
      let beforeId: string | null;
      if (!after) {
        beforeId = targetId;
      } else {
        const nextEl = items[index + 1] as
          HTMLElement | undefined;
        const nextGroup = nextEl?.getAttribute(
          "data-group-id"
        );
        beforeId =
          nextEl && nextGroup === targetGroup
            ? (nextEl.getAttribute(
                "data-session-id"
              ) ?? null)
            : null;
      }
      if (beforeId !== session.id) {
        onMove(session.id, targetGroup, beforeId);
        console.debug(
          `[sidebar] 会话移动 ${session.id} → 分组「${targetGroup || "未分组"}」位置 ${beforeId ?? "组末"}`
        );
      }
    };
    window.addEventListener(
      "pointermove",
      onDragMove
    );
    window.addEventListener(
      "pointerup",
      onDragEnd
    );
  }

  return (
    // aside 保留 complementary 语义；面板底色/描边/圆角走 .sidebar（HeroUI token）。
    // 收起/展开的开关在左侧竖条（AppRail）上，这里只负责展开态的内容。
    // 空白处点击不抢终端焦点（keepTerminalFocus）
    <aside
      className="sidebar"
      onMouseDown={keepTerminalFocus}
    >
      <Header className="sidebar-head">
        <div>
          <span>{t("sidebar.title")}</span>
          <small>{sessions.length}</small>
        </div>
        {/* 两个动作按钮归到一个组里：.sidebar-head 是 space-between，
            直接平铺三个子元素会把「新建分组」顶到左、「新建会话」顶到右，
            中间空一大段。包成容器后按钮贴着标题排。 */}
        <div className="sidebar-head-actions">
          <Hint label={t("group.new")}>
            <Button
              className="sidebar-new-group"
              size="sm"
              isIconOnly
              aria-label={t("group.new")}
              onPress={onCreateGroup}
            >
              <FolderAddOutlined />
            </Button>
          </Hint>
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
        </div>
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
          // 关掉 WebView2 的表单自动填充：搜索框聚焦时弹出浏览器
          // 存过的历史值，会盖住下面的分组列表
          autoComplete="off"
          placeholder={t(
            "sidebar.searchPlaceholder"
          )}
        />
      </TextField>
      <div className="session-groups">
        {views.length ? (
          views.map(view => (
            <SessionGroupSection
              key={view.id || "ungrouped"}
              view={view}
              group={
                view.builtin
                  ? null
                  : (groupById.get(view.id) ??
                    null)
              }
              activeId={activeId}
              searching={searching}
              onToggle={onToggleGroup}
              onEditGroup={onEditGroup}
              onRemoveGroup={onRemoveGroup}
              onCreateIn={onCreateInGroup}
              onSessionPointerDown={
                startSessionDrag
              }
              onSessionDoubleClick={onDuplicate}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))
        ) : (
          <p className="empty-list">
            {t("sidebar.noMatch")}
          </p>
        )}
      </div>
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
