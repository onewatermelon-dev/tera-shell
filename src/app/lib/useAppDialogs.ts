import { logError } from "@/shared/lib/log";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  parseImportPayload,
  serializeExport,
  type ImportPreview
} from "@/sessions/lib/sessionTransfer";
import type { SessionGroup } from "@/sessions/lib/sessionGroup";
import type { SavedSession } from "@/sessions/lib/session";
import type { Translator } from "@/settings/lib/i18n";
// 只取类型：两个 store 仍由门面创建（一个应用只准有一份会话/分组状态），
// 这里按 ReturnType 拿它们的返回面，方法签名改动会在这里直接报错
import type { useSessions } from "@/sessions/lib/useSessions";
import type { useSessionGroups } from "@/sessions/lib/useSessionGroups";

/** useSessions 的返回面。 */
type SessionsStore = ReturnType<
  typeof useSessions
>;
/** useSessionGroups 的返回面。 */
type GroupsStore = ReturnType<
  typeof useSessionGroups
>;

/**
 * 会话 / 分组相关的全部弹窗状态与处理函数。
 *
 * 从 App.tsx 整体搬出：这些状态自成一体（开/关/编辑态/待确认项），
 * 消费方是底部的对话框 JSX 与标题栏菜单，留在门面里会把渲染逻辑
 * 冲散。store 通过参数注入，不在本 hook 内创建。
 */
export function useAppDialogs(options: {
  sessionStore: SessionsStore;
  groupStore: GroupsStore;
  t: Translator;
  setError: (message: string) => void;
}) {
  const {
    sessionStore,
    groupStore,
    t,
    setError
  } = options;
  const {
    sessions,
    save,
    update,
    remove,
    addMany: addManySessions,
    unassignGroup
  } = sessionStore;
  const {
    groups,
    add: addGroup,
    addMany: addManyGroups,
    update: updateGroup,
    remove: removeGroup
  } = groupStore;

  const [dialogOpen, setDialogOpen] =
    useState(false);
  const [editingSession, setEditingSession] =
    useState<SavedSession | null>(null);
  // 分组弹窗：editingGroup 为 null 表示本次是「新建分组」
  const [groupDialogOpen, setGroupDialogOpen] =
    useState(false);
  const [editingGroup, setEditingGroup] =
    useState<SessionGroup | null>(null);
  // 待确认删除的分组（null = 没有待确认项）
  const [groupToRemove, setGroupToRemove] =
    useState<SessionGroup | null>(null);
  // 待确认删除的会话（null = 没有待确认项）
  const [sessionToRemove, setSessionToRemove] =
    useState<SavedSession | null>(null);
  /**
   * 待确认导入的内容（null = 当前没有待确认的导入）。
   *
   * 解析结果先落在状态里、再让用户确认，是为了让「会导入几条、有几条
   * 重复」这些数字能在确认框里如实显示 —— 直接倒进去的话用户根本无从
   * 知晓会发生什么。
   */
  const [pendingImport, setPendingImport] =
    useState<ImportPreview | null>(null);
  // 新建会话时预选的分组
  const [newSessionGroup, setNewSessionGroup] =
    useState<string>("");
  /**
   * 弹窗「本次打开」的递增令牌。
   *
   * 会话/分组弹窗都用 useState 初始化表单，只在挂载时跑一次，而 key 里的
   * id 只在**编辑**时有值 —— 新建时 key 恒为 "new"，同一个 key 复用同一个
   * 组件实例，于是「打开→填一半→关掉→再打开」会带着上次的残留表单
   * （新建会话表现为落错分组，新建分组表现为残留上次输入的名字）。
   *
   * 令牌每次打开自增，key 就永远不同，必然重挂载。比在 key 里拼业务字段
   * 稳（那种写法要求每个字段都不能漏，且漏了就是静默 bug）。
   */
  const [dialogToken, setDialogToken] =
    useState(0);

  function openCreate() {
    setEditingSession(null);
    // 会话弹窗里分组是必填项：侧栏标题栏的「+」没有分组上下文，
    // 预选第一个分组让常见路径只需填连接信息；一个分组都没有时才留空，
    // 由弹窗提示用户填。
    setNewSessionGroup(groups[0]?.id ?? "");
    setDialogToken(token => token + 1);
    setDialogOpen(true);
  }

  /**
   * 打开新建会话弹窗并预选目标分组。
   *
   * 侧栏分组标题行的「+」走这里 —— 用户已经用「点哪个分组的加号」
   * 表明了意图，再让他在弹窗里重选一遍是白填。
   */
  function openCreateInGroup(groupId: string) {
    setEditingSession(null);
    setNewSessionGroup(groupId);
    setDialogToken(token => token + 1);
    setDialogOpen(true);
  }

  function openEdit(session: SavedSession) {
    setEditingSession(session);
    setDialogToken(token => token + 1);
    setDialogOpen(true);
  }

  function openCreateGroup() {
    setEditingGroup(null);
    setDialogToken(token => token + 1);
    setGroupDialogOpen(true);
  }

  function openEditGroup(group: SessionGroup) {
    setEditingGroup(group);
    setDialogToken(token => token + 1);
    setGroupDialogOpen(true);
  }

  /**
   * 保存会话。`pendingGroupName` 是弹窗分组框里手输、尚不存在的分组名。
   *
   * 先建组拿到 id 再挂会话 —— 顺序反了会话就指向空气；虽然 groupSessions
   * 会把它们兜进未分组节，但数据上是悬空引用，同名分组日后重建还会跳回去。
   */
  function saveSession(
    session: SavedSession,
    pendingGroupName: string
  ) {
    let groupId = session.groupId ?? "";
    if (pendingGroupName) {
      groupId = addGroup({
        name: pendingGroupName
      });
      console.debug(
        `[groups] 保存会话时顺带新建分组：${pendingGroupName}`
      );
    }
    const next = {
      ...session,
      groupId
    };
    if (editingSession) update(next);
    else save(next);
    setDialogOpen(false);
  }

  function saveGroup(group: SessionGroup) {
    if (editingGroup) {
      updateGroup(group.id, {
        name: group.name,
        color: group.color
      });
    } else {
      addGroup({
        name: group.name,
        color: group.color
      });
    }
    setGroupDialogOpen(false);
  }

  /**
   * 确认删除分组：把组内会话一并移回未分组。
   *
   * 只删分组不清理引用的话，那些会话的 groupId 会悬空；同名分组日后重建，
   * 它们会莫名跳回旧组。console 留痕，方便事后对账。
   */
  function confirmRemoveGroup() {
    if (!groupToRemove) return;
    const id = groupToRemove.id;
    unassignGroup(id);
    removeGroup(id);
    console.info(
      `[groups] 删除分组「${groupToRemove.name}」，组内会话已移回未分组`
    );
  }

  /**
   * 确认删除会话。
   *
   * 二次确认的价值：会话是用户逐条攒下来的连接信息，点错那个 × 就没了，
   * 且没有撤销入口。本机终端（id=local）不参与 —— 它是内置的、
   * 侧栏本来就不给删除按钮。
   */
  function confirmRemoveSession() {
    if (!sessionToRemove) return;
    remove(sessionToRemove.id);
    console.info(
      `[sessions] 删除会话「${sessionToRemove.name}」（${sessionToRemove.kind}）`
    );
  }

  /**
   * 把当前会话与分组导出到 JSON 文件。
   *
   * 本机终端不在导出范围内（见 buildExportPayload）。密码由后端那条
   * 「写文件」命令随内容一起落盘，所以这里传出去的 JSON 已经不含密码。
   */
  async function exportSessions() {
    if (sessions.length === 0) {
      setError(t("transfer.exportEmpty"));
      return;
    }
    try {
      const path = await invoke<string | null>(
        "export_to_file",
        {
          content: serializeExport(
            sessions,
            groups
          )
        }
      );
      // 用户取消保存框：后端返回 null，不是错误，静默收手
      if (!path) return;
      console.info(
        `[transfer] 导出 ${sessions.length} 个会话到 ${path}`
      );
      console.info(
        `[transfer] 导出完成：${sessions.length} 个会话`
      );
    } catch (reason) {
      logError("导出会话失败", reason);
      setError(
        t("transfer.exportFailed", {
          error: String(reason)
        })
      );
    }
  }

  /**
   * 选文件 → 解析 → 停在确认框。
   *
   * 解析失败（选错文件、格式不对、版本过新）一律在这里就地提示，不弹框。
   * 传现有会话与分组：连接目标已存在的整条跳过，同名分组并入现有分组。
   * 全被跳过时不弹「导入 0 个会话」的确认框，直接提示后收手。
   */
  async function importSessions() {
    try {
      const raw = await invoke<string | null>(
        "import_from_file"
      );
      if (!raw) return;
      const result = parseImportPayload(
        raw,
        sessions,
        groups
      );
      if (!result.ok) {
        setError(
          t("transfer.importFailed", {
            error: result.error
          })
        );
        return;
      }
      // 整份文件里的会话都已在列表中：没什么可导的，
      // 弹确认框让用户点「导入」再看结果只会莫名其妙
      if (result.sessions.length === 0) {
        console.info(
          `[transfer] 导入中止：${result.skipped} 条会话均已存在`
        );
        setError(
          t("transfer.importNothingNew", {
            count: result.skipped
          })
        );
        return;
      }
      setPendingImport(result);
    } catch (reason) {
      logError("读取会话文件失败", reason);
      setError(
        t("transfer.importFailed", {
          error: String(reason)
        })
      );
    }
  }

  /** 确认导入：分组与会话各一次写盘，顺序不能反 —— 会话要引用分组 id。 */
  function confirmImport() {
    if (!pendingImport) return;
    addManyGroups(pendingImport.groups);
    addManySessions(pendingImport.sessions);
    console.info(
      `[transfer] 导入 ${pendingImport.sessions.length} 个会话、新建 ${pendingImport.groups.length} 个分组（跳过已有 ${pendingImport.skipped} 条，${pendingImport.mergedGroups} 个同名分组并入现有分组）`
    );
    setPendingImport(null);
  }

  return {
    dialogOpen,
    setDialogOpen,
    editingSession,
    groupDialogOpen,
    setGroupDialogOpen,
    editingGroup,
    groupToRemove,
    setGroupToRemove,
    sessionToRemove,
    setSessionToRemove,
    pendingImport,
    setPendingImport,
    newSessionGroup,
    dialogToken,
    openCreate,
    openCreateInGroup,
    openEdit,
    openCreateGroup,
    openEditGroup,
    saveSession,
    saveGroup,
    confirmRemoveGroup,
    confirmRemoveSession,
    exportSessions,
    importSessions,
    confirmImport
  };
}
