import {
  useEffect,
  useMemo,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import {
  ArrowLeftOutlined,
  BgColorsOutlined,
  CodeOutlined,
  DesktopOutlined,
  GlobalOutlined,
  MoonOutlined,
  SunOutlined,
  TranslationOutlined
} from "@ant-design/icons";
import SettingsRow from "@/features/settings/SettingsRow";
import DataDirRow from "@/features/settings/DataDirRow";
import SettingsSelect, {
  type SelectOption
} from "@/features/settings/SettingsSelect";
import {
  useT,
  type Translator
} from "@/features/settings/i18n";
import {
  clampFontSize,
  firstFontOf,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  resolveFontFamily,
  type AppSettings,
  type LanguageMode,
  type ThemeMode
} from "@/features/settings/settings";

/** 左侧导航的两页。 */
type Section = "general" | "terminal";

/** 主题下拉的三项。 */
const themeOptions = (
  t: Translator
): SelectOption<ThemeMode>[] => [
  {
    value: "system",
    label: t("option.system"),
    icon: <DesktopOutlined />
  },
  {
    value: "light",
    label: t("option.light"),
    icon: <SunOutlined />
  },
  {
    value: "dark",
    label: t("option.dark"),
    icon: <MoonOutlined />
  }
];

/** 界面语言下拉。 */
const localeOptions = (
  t: Translator
): SelectOption<LanguageMode>[] => [
  {
    value: "system",
    label: t("option.system"),
    icon: <DesktopOutlined />
  },
  {
    value: "zh-CN",
    label: t("option.zhCN"),
    icon: <TranslationOutlined />
  },
  {
    value: "en-US",
    label: t("option.enUS"),
    icon: <GlobalOutlined />
  }
];

type SettingsPageProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onBack: () => void;
};

/**
 * 设置页：左侧导航 + 右侧卡片列表。
 *
 * 字体与字号采用「草稿 + 保存」而不是即时生效 —— 它们会触发终端重排，
 * 每敲一个字符就重算一次既卡顿又闪烁。主题是纯属性切换，改用即时生效。
 */
export default function SettingsPage({
  settings,
  onChange,
  onBack
}: SettingsPageProps) {
  const t = useT();
  // 选项文案随语言变化，按需生成并跟着 t 一起 memo
  const themeList = useMemo(
    () => themeOptions(t),
    [t]
  );
  const localeList = useMemo(
    () => localeOptions(t),
    [t]
  );
  const [section, setSection] =
    useState<Section>("general");
  // 草稿与已保存值分开，才能判断"有没有改动"来决定保存按钮是否可点
  const [fontDraft, setFontDraft] = useState(
    settings.fontFamily
  );
  const [sizeDraft, setSizeDraft] = useState(
    String(settings.fontSize)
  );
  // 本机字体清单：字体名上百条，用 <datalist> 而不是自绘下拉 ——
  // 输入框保留手输能力（可以填字体栈），下拉部分由浏览器按输入过滤
  const [fonts, setFonts] = useState<string[]>(
    []
  );

  useEffect(() => {
    invoke<string[]>("list_fonts")
      .then(setFonts)
      .catch(() => {});
  }, []);

  const fontChanged =
    fontDraft.trim() !== settings.fontFamily;
  const sizeChanged =
    clampFontSize(sizeDraft) !==
    settings.fontSize;

  function saveFont() {
    onChange({ fontFamily: fontDraft.trim() });
  }

  function saveSize() {
    const size = clampFontSize(sizeDraft);
    // 输入越界时把输入框校正回合法值，免得用户以为改没生效
    setSizeDraft(String(size));
    onChange({ fontSize: size });
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button
          type="button"
          className="settings-back"
          onClick={onBack}
        >
          <ArrowLeftOutlined />
          {t("settings.back")}
        </button>
        <p className="settings-nav-group">
          {t("settings.nav.group")}
        </p>
        <button
          type="button"
          className={
            section === "general"
              ? "settings-nav-item is-active"
              : "settings-nav-item"
          }
          onClick={() => setSection("general")}
        >
          <BgColorsOutlined />
          {t("settings.nav.general")}
        </button>
        <button
          type="button"
          className={
            section === "terminal"
              ? "settings-nav-item is-active"
              : "settings-nav-item"
          }
          onClick={() => setSection("terminal")}
        >
          <CodeOutlined />
          {t("settings.nav.terminal")}
        </button>
      </aside>

      <section className="settings-content">
        <h1 className="settings-title">
          {section === "general"
            ? t("settings.nav.general")
            : t("settings.nav.terminal")}
        </h1>
        <p className="settings-subtitle">
          {t("settings.subtitle")}
        </p>

        {section === "general" ? (
          <>
            <SettingsRow
              title={t("settings.locale.title")}
              description={t(
                "settings.locale.desc"
              )}
              control={
                <SettingsSelect
                  value={settings.locale}
                  options={localeList}
                  ariaLabel={t(
                    "settings.locale.title"
                  )}
                  onChange={locale =>
                    onChange({ locale })
                  }
                />
              }
            />
            <SettingsRow
              title={t("settings.theme.title")}
              description={t(
                "settings.theme.desc"
              )}
              control={
                <SettingsSelect
                  value={settings.theme}
                  options={themeList}
                  ariaLabel={t(
                    "settings.theme.title"
                  )}
                  onChange={theme =>
                    onChange({ theme })
                  }
                />
              }
            />
            <DataDirRow />
          </>
        ) : (
          <>
            <SettingsRow
              title={t("settings.font.title")}
              description={t(
                "settings.font.desc"
              )}
              control={
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={!fontChanged}
                  onPress={saveFont}
                >
                  {t("common.save")}
                </Button>
              }
            >
              <input
                className="settings-input"
                value={fontDraft}
                spellCheck={false}
                list="font-options"
                aria-label={t(
                  "settings.font.title"
                )}
                placeholder={t(
                  "settings.font.placeholder",
                  {
                    name: firstFontOf(
                      resolveFontFamily(
                        settings.fontFamily
                      )
                    )
                  }
                )}
                onChange={event =>
                  setFontDraft(event.target.value)
                }
                onKeyDown={event => {
                  if (event.key === "Enter")
                    saveFont();
                }}
              />
              {/* 候选来自后端的 GDI 枚举；datalist 让浏览器按输入过滤，
                  输入框本身仍可手填任意字体栈 */}
              <datalist id="font-options">
                {fonts.map(name => (
                  <option
                    key={name}
                    value={name}
                  />
                ))}
              </datalist>
            </SettingsRow>

            <SettingsRow
              title={t("settings.fontSize.title")}
              description={t(
                "settings.fontSize.desc",
                {
                  min: MIN_FONT_SIZE,
                  max: MAX_FONT_SIZE
                }
              )}
              control={
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={!sizeChanged}
                  onPress={saveSize}
                >
                  {t("common.save")}
                </Button>
              }
            >
              <input
                className="settings-input settings-input--size"
                value={sizeDraft}
                inputMode="numeric"
                aria-label={t(
                  "settings.fontSize.title"
                )}
                placeholder={String(
                  settings.fontSize
                )}
                onChange={event =>
                  setSizeDraft(event.target.value)
                }
                onKeyDown={event => {
                  if (event.key === "Enter")
                    saveSize();
                }}
              />
            </SettingsRow>
          </>
        )}
      </section>
    </div>
  );
}
