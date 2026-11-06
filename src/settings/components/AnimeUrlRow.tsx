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
 *
 * 同一块里还带「Bangumi 追番同步」令牌行（可选，同一个配置文件）。
 */
export default function AnimeUrlRow() {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [bgmToken, setBgmToken] = useState("");
  const [bgmSaving, setBgmSaving] =
    useState(false);
  const [ddpId, setDdpId] = useState("");
  const [ddpSecret, setDdpSecret] = useState("");
  const [ddpSaving, setDdpSaving] =
    useState(false);

  useEffect(() => {
    void loadAnimeConfig()
      .then(config => {
        setDraft(config.baseUrl);
        setBgmToken(config.bgmToken ?? "");
        setDdpId(config.danmuAppId ?? "");
        setDdpSecret(config.danmuAppSecret ?? "");
      })
      .catch(() => {});
  }, []);

  /** 归一化并落盘；保存成功后不打扰用户（设置页无 toast 通道）。 */
  async function persist(value: string) {
    const host = value.trim().replace(/\/+$/, "");
    if (host === draft && saving) return;
    setSaving(true);
    try {
      // 读改写合并：整体覆盖会把音量/进度/收藏等其它字段抹掉
      const config = await loadAnimeConfig();
      await saveAnimeConfig({
        ...config,
        baseUrl: host
      });
    } finally {
      setSaving(false);
    }
  }

  /** Bangumi 令牌落盘（同样的读改写合并）。 */
  async function persistBgmToken(value: string) {
    const token = value.trim();
    if (token === bgmToken && bgmSaving) return;
    setBgmSaving(true);
    try {
      const config = await loadAnimeConfig();
      await saveAnimeConfig({
        ...config,
        bgmToken: token
      });
    } finally {
      setBgmSaving(false);
    }
  }

  /** 弹弹play 凭证落盘（两个输入共用一个确认）。 */
  async function persistDdp() {
    if (ddpSaving) return;
    setDdpSaving(true);
    try {
      const config = await loadAnimeConfig();
      await saveAnimeConfig({
        ...config,
        danmuAppId: ddpId.trim(),
        danmuAppSecret: ddpSecret.trim()
      });
    } finally {
      setDdpSaving(false);
    }
  }

  return (
    <>
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
      <SettingsRow
        title={t("anime.bgm.title")}
        description={t("anime.bgm.desc")}
        control={
          <Button
            variant="tertiary"
            size="sm"
            isDisabled={bgmSaving}
            onPress={() =>
              persistBgmToken(bgmToken)
            }
          >
            {t("common.confirm")}
          </Button>
        }
      >
        <input
          className="settings-input"
          type="password"
          value={bgmToken}
          spellCheck={false}
          placeholder="Bangumi access token"
          aria-label={t("anime.bgm.title")}
          onChange={event =>
            setBgmToken(event.target.value)
          }
          onBlur={() => persistBgmToken(bgmToken)}
          onKeyDown={event => {
            if (event.key === "Enter")
              persistBgmToken(bgmToken);
          }}
        />
      </SettingsRow>
      <SettingsRow
        title={t("anime.ddp.title")}
        description={t("anime.ddp.desc")}
        control={
          <Button
            variant="tertiary"
            size="sm"
            isDisabled={ddpSaving}
            onPress={() => void persistDdp()}
          >
            {t("common.confirm")}
          </Button>
        }
      >
        <div className="settings-stack">
          <input
            className="settings-input"
            value={ddpId}
            spellCheck={false}
            placeholder="AppId"
            aria-label="AppId"
            onChange={event =>
              setDdpId(event.target.value)
            }
            onBlur={() => void persistDdp()}
          />
          <input
            className="settings-input"
            type="password"
            value={ddpSecret}
            spellCheck={false}
            placeholder="AppSecret"
            aria-label="AppSecret"
            onChange={event =>
              setDdpSecret(event.target.value)
            }
            onBlur={() => void persistDdp()}
          />
        </div>
      </SettingsRow>
    </>
  );
}
