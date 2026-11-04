import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import SettingsRow from "@/settings/components/SettingsRow";
import {
  loadAnimeConfig,
  saveAnimeConfig
} from "@/anime/lib/store";

/**
 * 设置页「动漫 API 地址」一项。
 *
 * 数据与动漫弹层共用 `anime.json`（loadAnimeConfig/saveAnimeConfig），
 * 原本这地址在动漫弹层顶部输入，现收进设置页「通用」分区。
 * 输入框边打边存、失焦时也存一次兜底。
 */
export default function AnimeUrlRow() {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadAnimeConfig()
      .then(config => setDraft(config.baseUrl))
      .catch(() => {});
  }, []);

  /** 归一化并落盘；保存成功后不打扰用户（设置页无 toast 通道）。 */
  async function persist(value: string) {
    const host = value.trim().replace(/\/+$/, "");
    if (host === draft && saving) return;
    setSaving(true);
    try {
      await saveAnimeConfig({ baseUrl: host });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      title={t("anime.apiUrl.title")}
      description={t("anime.apiUrl.desc")}
      control={
        <Button
          variant="tertiary"
          size="sm"
          isDisabled={saving}
          onPress={() => persist(draft)}
        >
          {t("common.confirm")}
        </Button>
      }
    >
      <input
        className="settings-input"
        value={draft}
        spellCheck={false}
        placeholder="https://api.example.com"
        aria-label={t("anime.apiUrl.title")}
        onChange={event =>
          setDraft(event.target.value)
        }
        onBlur={() => persist(draft)}
        onKeyDown={event => {
          if (event.key === "Enter")
            persist(draft);
        }}
      />
    </SettingsRow>
  );
}
