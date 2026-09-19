import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { FolderOpenOutlined } from "@ant-design/icons";
import SettingsRow from "@/settings/components/SettingsRow";
import { useT } from "@/settings/lib/i18n";

/**
 * 设置页的「数据存储路径」一项。
 *
 * 后端会把现有数据复制到新目录、成功后才记配置，所以这里的保存是
 * **真正切换数据位置**，不只是改个显示值。切换后无需重启 ——
 * 后续写入都会重新读取配置，落到新目录。
 */
export default function DataDirRow() {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // 挂载时读一次当前根目录：它存在后端配置里，不在前端设置项里
  useEffect(() => {
    invoke<string>("current_root")
      .then(value => {
        setDraft(value);
        setSaved(value);
      })
      .catch(() => {});
  }, []);

  const changed = draft.trim() !== saved;

  /** 弹出系统文件夹选择框；用户取消时保持原样。 */
  async function pick() {
    try {
      const picked = await invoke<string | null>(
        "pick_data_dir"
      );
      if (picked) {
        setDraft(picked);
        setMessage("");
      }
    } catch (reason) {
      setMessage(String(reason));
    }
  }

  /** 保存：后端复制数据 + 记配置，成功后才更新本地显示。 */
  async function save() {
    const dir = draft.trim();
    if (!dir) return;
    setBusy(true);
    try {
      const destination = await invoke<string>(
        "set_data_dir",
        { dir }
      );
      setDraft(destination);
      setSaved(destination);
      setMessage(
        t("settings.dataDir.saved", {
          path: destination
        })
      );
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsRow
      title={t("settings.dataDir.title")}
      description={t("settings.dataDir.desc")}
      control={
        <div className="data-dir-actions">
          <Button
            variant="tertiary"
            size="sm"
            onPress={pick}
          >
            {t("settings.dataDir.pick")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={!changed || busy}
            onPress={save}
          >
            {t("common.save")}
          </Button>
        </div>
      }
    >
      <div className="data-dir-field">
        <FolderOpenOutlined className="data-dir-icon" />
        <input
          className="settings-input data-dir-input"
          value={draft}
          spellCheck={false}
          aria-label={t("settings.dataDir.title")}
          placeholder={t(
            "settings.dataDir.placeholder"
          )}
          onChange={event =>
            setDraft(event.target.value)
          }
        />
      </div>
      {message && (
        <p className="data-dir-message">
          {message}
        </p>
      )}
    </SettingsRow>
  );
}
