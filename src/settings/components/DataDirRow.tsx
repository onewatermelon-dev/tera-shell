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
 *
 * ## 没有保存按钮（2026-10-19 用户要求）
 *
 * 保存时机是「选中文件夹」与「输入框失焦」两个自然收尾动作 ——
 * 一个独立的保存按钮反而多一次必点的步骤。失焦时没变化就不保存；
 * 保存仍是幂等的同一路径时后端复制会短路，不会反复搬数据。
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

  /**
   * 保存：后端复制数据 + 记配置，成功后才更新本地显示。
   *
   * `dir` 走参数而不是读 state：选文件夹的路径与 pick() 写进 draft 的
   * 值必须是同一个，避免依赖「setDraft 后立即读到新值」的错觉。
   */
  async function save(dir: string) {
    const target = dir.trim();
    // 空路径不保存：留空是「没填完」的中间态，不是合法目标
    if (!target) return;
    setBusy(true);
    try {
      const destination = await invoke<string>(
        "set_data_dir",
        { dir: target }
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

  /** 弹出系统文件夹选择框；选中即保存，取消时保持原样。 */
  async function pick() {
    try {
      const picked = await invoke<string | null>(
        "pick_data_dir"
      );
      if (picked) {
        setMessage("");
        await save(picked);
      }
    } catch (reason) {
      setMessage(String(reason));
    }
  }

  /** 失焦收尾：有改动且非空才保存；中途打了一半的空串撤回原值。 */
  function commitOnBlur() {
    if (!draft.trim()) {
      setDraft(saved);
      return;
    }
    if (changed && !busy) void save(draft);
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
            isDisabled={busy}
            onPress={pick}
          >
            {t("settings.dataDir.pick")}
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
          disabled={busy}
          aria-label={t("settings.dataDir.title")}
          placeholder={t(
            "settings.dataDir.placeholder"
          )}
          onChange={event =>
            setDraft(event.target.value)
          }
          onBlur={commitOnBlur}
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
