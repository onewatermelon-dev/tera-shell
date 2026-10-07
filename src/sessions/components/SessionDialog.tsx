import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExportOutlined } from "@ant-design/icons";
import {
  Button,
  Form,
  Input,
  Label,
  Modal,
  TextField,
  Typography
} from "@heroui/react";
import {
  emptySshSession,
  type SavedSession
} from "@/sessions/lib/session";
import {
  normalizeColorTag,
  UNGROUPED_ID,
  type ColorTag
} from "@/sessions/lib/sessionGroup";
import type { SessionGroup } from "@/sessions/lib/sessionGroup";
import ColorPicker from "@/sessions/components/ColorPicker";
import { useT } from "@/settings/lib/i18n";

type Props = {
  open: boolean;
  session?: SavedSession | null;
  /** 已有分组，供下拉候选（新建会话时预选 initialGroupId 指定的分组）。 */
  groups: SessionGroup[];
  /** 打开时预选的分组；为空则落在未分组。 */
  initialGroupId?: string;
  onClose: () => void;
  /**
   * 提交会话。`pendingGroupName` 是用户在分组框里手输、但还没建过的分组名
   * （空串表示选了已有分组或未分组）—— App 拿它去建组并回填 groupId。
   */
  onSave: (
    session: SavedSession,
    pendingGroupName: string
  ) => void;
};

export default function SessionDialog({
  open,
  session,
  groups,
  initialGroupId,
  onClose,
  onSave
}: Props) {
  const t = useT();
  // 通过 key 强制重装，无需 effect 重置状态。
  // color 显式标注 ColorTag：空串字面量否则会被推成 string，传不进 ColorPicker
  const [form, setForm] = useState(() => {
    if (session)
      return {
        ...session,
        groupId: session.groupId ?? UNGROUPED_ID,
        color: (session.color ?? "") as ColorTag
      };
    const fresh = emptySshSession();
    delete (fresh as Partial<SavedSession>)
      .password;
    return {
      ...fresh,
      groupId: initialGroupId ?? UNGROUPED_ID,
      color: "" as ColorTag
    };
  });
  const [error, setError] = useState("");
  const [newPassword, setNewPassword] =
    useState("");

  /**
   * 分组框里显示的**名字**（不是 id）。
   *
   * 存名字而不是 id，是因为这里允许直接手输新分组名：名字是用户脑子里的
   * 东西，id 是内部实现。提交时才把名字翻回 id（见 resolveGroup）。
   */
  const [groupName, setGroupName] = useState(
    () => {
      if (session?.groupId)
        return (
          groups.find(
            item => item.id === session.groupId
          )?.name ?? ""
        );
      return (
        groups.find(
          item => item.id === initialGroupId
        )?.name ?? ""
      );
    }
  );

  /**
   * 把分组名翻成 id。命中已有分组返回其 id；没命中返回空串，
   * 并由调用方把名字带出去建组 —— 这样「输入新名字 → 自动建组」
   * 只需一次保存，不必先回列表建好分组再回来选。
   */
  function resolveGroup(name: string): {
    groupId: string;
    pending: string;
  } {
    const trimmed = name.trim();
    // 分组框留空：保持会话原本的 groupId。
    // 分组被改名或删除后这里会显示空，若此时存成未分组，
    // 就等于「改个别的字段」顺手把会话甩出分组了。
    if (!trimmed)
      return {
        groupId: form.groupId || UNGROUPED_ID,
        pending: ""
      };
    const hit = groups.find(
      item => item.name.trim() === trimmed
    );
    if (hit)
      return { groupId: hit.id, pending: "" };
    return {
      groupId: UNGROUPED_ID,
      pending: trimmed
    };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.host.trim()) {
      setError(t("session.hostRequired"));
      return;
    }
    /**
     * 新建连接时分组必填。
     *
     * 校验放在**提交时**而不是输入时：分组框允许手输新名字自动建组，
     * 输入过程中为空是正常的中间态，边打边报错会一直闪红。
     *
     * 只约束新建（`!session`）。编辑既有会话时留空表示「保持原分组」——
     * 存量数据里本来就有未分组的会话，逼着用户编辑别的字段时顺手
     * 给它选个分组反而是强制迁移。
     */
    if (!session && !groupName.trim()) {
      setError(t("session.groupRequired"));
      return;
    }
    const { groupId, pending } =
      resolveGroup(groupName);
    const next: SavedSession = {
      ...form,
      name: form.name.trim() || form.host.trim(),
      username: form.username.trim() || "root",
      groupId,
      color: normalizeColorTag(form.color)
    };
    // 编辑会话时新填的密码加密后写回；留空保持原密码。
    if (newPassword) {
      try {
        next.password = await invoke<string>(
          "encrypt",
          {
            plain: newPassword
          }
        );
      } catch (reason) {
        setError(String(reason));
        return;
      }
    }
    onSave(next, pending);
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog className="session-dialog">
            <Form onSubmit={submit}>
              <Modal.Header>
                <Typography.Paragraph
                  size="sm"
                  className="dialog-eyebrow"
                >
                  {session
                    ? t("session.editTitle")
                    : t("session.newTitle")}
                </Typography.Paragraph>
                <Modal.Heading>
                  {t("session.eyebrow")}
                </Modal.Heading>
                <Modal.CloseTrigger
                  aria-label={t(
                    "app.action.close"
                  )}
                />
              </Modal.Header>
              <Modal.Body className="dialog-fields">
                <TextField
                  name="name"
                  value={form.name}
                  onChange={v =>
                    setForm({ ...form, name: v })
                  }
                >
                  <Label>
                    {t("session.name")}
                  </Label>
                  <Input
                    autoFocus
                    /**
                     * 关掉 WebView2 的表单自动填充。
                     *
                     * 不关的话，用户在某个字段输入过一次后，浏览器会把
                     * 值存进 profile，之后**点该输入框**就弹出「保存的
                     * 值」下拉（历史记录），盖住下方字段 —— 截图里
                     * 会话名称框弹出的就是这个。它把 IP 之类的历史值
                     * 混进来，选错了很难察觉。
                     *
                     * ⚠️ 应用自己管会话数据，不需要浏览器记忆；
                     * 项目里 PasswordDialog 早用同样的办法治过。
                     */
                    autoComplete="off"
                    placeholder={t(
                      "session.namePlaceholder"
                    )}
                  />
                </TextField>
                <div className="form-row">
                  <TextField
                    className="grow"
                    name="host"
                    value={form.host}
                    onChange={v =>
                      setForm({
                        ...form,
                        host: v
                      })
                    }
                  >
                    <Label>
                      {t("session.host")}
                    </Label>
                    <Input
                      autoComplete="off"
                      placeholder="192.168.1.10"
                    />
                  </TextField>
                  <TextField
                    name="port"
                    className="port-field"
                    value={String(form.port)}
                    onChange={v =>
                      setForm({
                        ...form,
                        port: Number(v) || 0
                      })
                    }
                  >
                    <Label>
                      {t("session.port")}
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      autoComplete="off"
                    />
                  </TextField>
                </div>
                <TextField
                  name="username"
                  value={form.username}
                  onChange={v =>
                    setForm({
                      ...form,
                      username: v
                    })
                  }
                >
                  <Label>
                    {t("session.username")}
                  </Label>
                  <Input
                    autoComplete="off"
                    placeholder="root"
                  />
                </TextField>
                {/**
                 * 分组选择：可输入的 TextField + HeroUI Dropdown 候选菜单。
                 *
                 * 不用原生 <datalist>：那个下拉由**系统绘制**，改不了样式，
                 * 与界面主题不一致。走 Dropdown 后弹层用 HeroUI token，
                 * 深浅主题都对得上（与设置页 SettingsSelect 同一套做法）。
                 *
                 * 触发时机：点输入框或点右侧箭头都开菜单 —— 候选通常只有
                 * 几条，点开比「记得按箭头」顺手。
                 *
                 * 仍然允许手输新名字：选不中就当新分组，提交时建组
                 * （见 resolveGroup / App 的 pendingGroupName）。
                 */}
                <TextField
                  name="group"
                  value={groupName}
                  onChange={setGroupName}
                >
                  {/**
                   * isRequired 挂在 Label 上：TextField 不认这个 prop，
                   * 挂了会被静默丢弃；RAC 据此渲染必填标记。
                   * 编辑时留空 = 保持原分组，不是必填。
                   */}
                  <Label isRequired={!session}>
                    {t("session.group")}
                  </Label>
                  <Input
                    autoComplete="off"
                    placeholder={t(
                      session
                        ? "session.groupPlaceholder"
                        : "session.groupPlaceholderNew"
                    )}
                  />
                </TextField>

                <div className="form-row">
                  <span className="form-label">
                    {t("colorTag.label")}
                  </span>
                </div>
                <ColorPicker
                  value={form.color ?? ""}
                  onChange={v =>
                    setForm({
                      ...form,
                      color: v
                    })
                  }
                />
                {session && form.password && (
                  <TextField
                    name="password"
                    value={newPassword}
                    onChange={setNewPassword}
                  >
                    <Label>
                      {t("session.password")}
                    </Label>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder={t(
                        "session.passwordPlaceholder"
                      )}
                    />
                  </TextField>
                )}
                <Typography.Paragraph
                  size="sm"
                  className="dialog-hint"
                >
                  {t("session.authHint")}
                </Typography.Paragraph>
                {error && (
                  <Typography.Paragraph
                    size="sm"
                    className="dialog-error"
                  >
                    {error}
                  </Typography.Paragraph>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="tertiary"
                  size="sm"
                  onPress={onClose}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  type="submit"
                >
                  <ExportOutlined />
                  {t("session.save")}
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
