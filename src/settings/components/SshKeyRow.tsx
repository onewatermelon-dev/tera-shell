import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import SettingsRow from "@/settings/components/SettingsRow";
import type { AppSettings } from "@/settings/lib/settings";

type SshKeyRowProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
};

/** 后端 `fs_pick_file` 的返回结构（见 fs::PickedFile）。 */
type PickedFile = {
  path: string;
  name: string;
  size: number;
};

/**
 * 设置页的「默认私钥」一项：路径输入框 + 系统文件选择框。
 *
 * ## 边打边存（每次 change 都写设置）
 *
 * 与代理地址同一考虑：校验交给 ssh 自己做（它会明确报 No such file），
 * 前端只 trim。文件可能在另一台机器上、或尚未生成，本地拦着不让填
 * 反而挡住合法用法。
 *
 * ## 不清空的语义
 *
 * 空串 = 不指定，交给 ssh 走默认密钥与 agent —— 这是默认状态，
 * 没有「必须有一把钥匙」的约束。
 */
export default function SshKeyRow({
  settings,
  onChange
}: SshKeyRowProps) {
  const t = useT();

  /** 弹出系统文件选择框；用户取消时保持原样。 */
  async function pick() {
    try {
      const picked =
        await invoke<PickedFile | null>(
          "fs_pick_file"
        );
      if (picked?.path) {
        onChange({ sshKeyPath: picked.path });
      }
    } catch (reason) {
      // 打不开文件框属于环境问题，别静默 —— 但也没有常驻的提示位，
      // 打到控制台足够排查
      console.warn(
        "[settings] 选择私钥文件失败",
        reason
      );
    }
  }

  return (
    <SettingsRow
      title={t("settings.sshKey.title")}
      description={t("settings.sshKey.desc")}
      control={
        <div className="data-dir-actions">
          <Button
            variant="tertiary"
            size="sm"
            onPress={pick}
          >
            {t("settings.sshKey.pick")}
          </Button>
        </div>
      }
    >
      <input
        className="settings-input data-dir-input"
        value={settings.sshKeyPath}
        spellCheck={false}
        aria-label={t("settings.sshKey.title")}
        placeholder={t(
          "settings.sshKey.placeholder"
        )}
        onChange={event =>
          onChange({
            sshKeyPath: event.target.value
          })
        }
      />
    </SettingsRow>
  );
}
