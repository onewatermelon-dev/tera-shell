import type { RefObject } from "react";
import { Alert } from "@heroui/react";
import type { AppLoadingHandle } from "@/app/components/AppLoading";
import type { Translator } from "@/settings/lib/i18n";
import type { SavedSession } from "@/sessions/lib/session";
import type { SessionGroup } from "@/sessions/lib/sessionGroup";
import type { TerminalMacro } from "@/terminal/lib/macro/terminalMacros";
import SessionDialog from "@/sessions/components/SessionDialog";
import GroupDialog from "@/sessions/components/GroupDialog";
import ConfirmDialog from "@/shared/components/ConfirmDialog";
import PasswordDialog from "@/sessions/components/PasswordDialog";
import MacroDialog from "@/terminal/components/macro/MacroDialog";
import AppLoading from "@/app/components/AppLoading";
// 只取类型：弹窗状态由 useAppDialogs（门面调用）持有
import type { useAppDialogs } from "@/app/lib/useAppDialogs";

/** useTerminals 里 passwordRequest 的形状。 */
type PasswordRequest = {
  session: SavedSession;
  sourceSessionId: string;
};

type Props = {
  dialogs: ReturnType<typeof useAppDialogs>;
  groups: SessionGroup[];
  /** 全部已保存会话：会话弹窗的跳板机候选 */
  sessions: SavedSession[];
  t: Translator;
  passwordRequest: PasswordRequest | null;
  onSubmitPassword: (password: string) => void;
  /** 纯密钥 / agent 登录：绕过密码框直接启动 */
  onUseKeyAuth: () => void;
  onCancelPassword: () => void;
  macroOpen: boolean;
  editingMacro: TerminalMacro | null;
  onSaveMacro: (
    name: string,
    command: string
  ) => void;
  onCloseMacro: () => void;
  error: string;
  onDismissError: () => void;
  appReady: boolean;
  appLoadingRef: RefObject<AppLoadingHandle | null>;
  onLoadingFinished: () => void;
};

/**
 * 应用的全部模态与浮层：会话/分组弹窗、三处删除确认、导入确认、
 * 密码框、宏弹窗、错误气泡、开场加载层。
 *
 * 从 App.tsx 整体搬出：这部分是纯 JSX 组装，留着会把主渲染树
 * （顶栏 + 工作区）冲散。所有状态经 props 注入，本组件无自有状态。
 */
export default function AppDialogs({
  dialogs,
  groups,
  sessions,
  t,
  passwordRequest,
  onSubmitPassword,
  onUseKeyAuth,
  onCancelPassword,
  macroOpen,
  editingMacro,
  onSaveMacro,
  onCloseMacro,
  error,
  onDismissError,
  appReady,
  appLoadingRef,
  onLoadingFinished
}: Props) {
  return (
    <>
      <SessionDialog
        // key 带上 dialogToken：每次打开都是新实例，表单按本次的
        // initialGroupId 重新初始化（否则新建时 key 恒为 "new"，
        // 组件被复用，上一次的分组/输入会残留下来）
        key={`${dialogs.editingSession?.id ?? "new"}-${dialogs.dialogToken}`}
        open={dialogs.dialogOpen}
        session={dialogs.editingSession}
        groups={groups}
        sessions={sessions}
        initialGroupId={dialogs.newSessionGroup}
        onClose={() =>
          dialogs.setDialogOpen(false)
        }
        onSave={dialogs.saveSession}
      />
      <GroupDialog
        key={`${dialogs.editingGroup?.id ?? "new-group"}-${dialogs.dialogToken}`}
        open={dialogs.groupDialogOpen}
        group={dialogs.editingGroup}
        onClose={() =>
          dialogs.setGroupDialogOpen(false)
        }
        onSave={dialogs.saveGroup}
      />
      {dialogs.groupToRemove && (
        <ConfirmDialog
          key={dialogs.groupToRemove.id}
          eyebrow={t("group.remove")}
          title={t("group.removeTitle")}
          description={t(
            "group.removeDescription",
            {
              name: dialogs.groupToRemove.name
            }
          )}
          confirmText={t("group.remove")}
          danger
          onConfirm={dialogs.confirmRemoveGroup}
          onClose={() =>
            dialogs.setGroupToRemove(null)
          }
        />
      )}
      {dialogs.sessionToRemove && (
        <ConfirmDialog
          key={dialogs.sessionToRemove.id}
          eyebrow={t("session.remove")}
          title={t("session.removeTitle", {
            name: dialogs.sessionToRemove.name
          })}
          description={t(
            "session.removeDescription"
          )}
          confirmText={t("session.remove")}
          danger
          onConfirm={dialogs.confirmRemoveSession}
          onClose={() =>
            dialogs.setSessionToRemove(null)
          }
        />
      )}
      {dialogs.pendingImport && (
        <ConfirmDialog
          // 一次性的令牌：连续导入两个文件时，内容变了但组件类型没变，
          // 不加 key 会复用上一次的实例
          key={
            dialogs.pendingImport.sessions[0]
              ?.id ?? "import"
          }
          eyebrow={t("transfer.import")}
          title={t("transfer.importTitle", {
            sessions:
              dialogs.pendingImport.sessions
                .length,
            groups:
              dialogs.pendingImport.groups.length
          })}
          description={[
            t("transfer.importDescription"),
            dialogs.pendingImport.mergedGroups > 0
              ? t("transfer.importMerged", {
                  count:
                    dialogs.pendingImport
                      .mergedGroups
                })
              : null,
            dialogs.pendingImport.skipped > 0
              ? t("transfer.importSkipped", {
                  count:
                    dialogs.pendingImport.skipped
                })
              : null
          ]
            .filter(Boolean)
            .join(" ")}
          confirmText={t("transfer.import")}
          onConfirm={dialogs.confirmImport}
          onClose={() =>
            dialogs.setPendingImport(null)
          }
        />
      )}
      {passwordRequest && (
        <PasswordDialog
          key={passwordRequest.session.id}
          session={passwordRequest.session}
          onSubmit={onSubmitPassword}
          onUseKey={onUseKeyAuth}
          onCancel={onCancelPassword}
        />
      )}
      {macroOpen && (
        <MacroDialog
          key={editingMacro?.id ?? "new"}
          macro={editingMacro}
          onSave={onSaveMacro}
          onClose={onCloseMacro}
        />
      )}
      {error && (
        <Alert
          status="danger"
          className="app-toast"
          onClick={onDismissError}
        >
          <Alert.Content>
            <Alert.Description>
              {error}
            </Alert.Description>
          </Alert.Content>
          {/* 真正可点的关闭钮：原来只是 ::after 画了个装饰性 ×，
              伪元素不接收事件，点了当然没反应 */}
          <button
            type="button"
            className="app-toast-close"
            aria-label={t("app.action.close")}
            onClick={event => {
              event.stopPropagation();
              onDismissError();
            }}
          >
            ×
          </button>
        </Alert>
      )}
      {!appReady && (
        <AppLoading
          ref={appLoadingRef}
          onFinished={onLoadingFinished}
        />
      )}
    </>
  );
}
