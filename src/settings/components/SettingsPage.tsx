import {
  useEffect,
  useMemo,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ApiOutlined,
  ArrowLeftOutlined,
  BgColorsOutlined,
  CodeOutlined,
  DesktopOutlined,
  FormatPainterOutlined,
  GlobalOutlined,
  KeyOutlined,
  MoonOutlined,
  SunOutlined,
  TranslationOutlined
} from "@ant-design/icons";
import SettingsRow from "@/settings/components/SettingsRow";
import Toggle from "@/shared/components/Toggle";
import DataDirRow from "@/settings/components/DataDirRow";
import ColorSchemePicker from "@/settings/components/ColorSchemePicker";
import { resolveColorScheme } from "@/terminal/lib/colorSchemes";
import ModelProvidersPage from "@/settings/components/ModelProvidersPage";
import ShortcutSettings from "@/settings/components/ShortcutSettings";
import SettingsSelect, {
  type SelectOption
} from "@/settings/components/SettingsSelect";
import {
  useT,
  type Translator
} from "@/settings/lib/i18n";
import {
  firstFontOf,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SCROLLBACK_PRESETS,
  TERMINAL_FONT_FALLBACK,
  type AppSettings,
  type CursorStyle,
  type LanguageMode,
  type ThemeMode
} from "@/settings/lib/settings";

/** 左侧导航的四页。 */
type Section =
  | "general"
  | "terminal"
  | "colorScheme"
  | "models"
  | "shortcuts";

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

/** 终端光标形状下拉。 */
const cursorStyleOptions = (
  t: Translator
): SelectOption<CursorStyle>[] => [
  {
    value: "block",
    label: t("settings.cursor.block")
  },
  {
    value: "underline",
    label: t("settings.cursor.underline")
  },
  {
    value: "bar",
    label: t("settings.cursor.bar")
  }
];

/**
 * 回滚行数下拉：只列预设档位，外加「当前值」。
 *
 * 补当前值是为了手改过设置文件、或早期数据留下的非档位值（如 3000）——
 * 不补的话 SettingsSelect 找不到选中项会回退成第一项，用户会看到
 * 5,000 行这种与实际不符的显示。
 */
const scrollbackOptions = (
  t: Translator,
  current: number
): SelectOption<string>[] => {
  const values = [...SCROLLBACK_PRESETS];
  if (!values.includes(current)) {
    values.push(current);
    values.sort((a, b) => a - b);
  }
  return values.map(value => ({
    value: String(value),
    label: t("settings.scrollback.unit", {
      // 千分位：100000 直接写出来一眼读不出量级
      value: value.toLocaleString()
    })
  }));
};

type SettingsPageProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onBack: () => void;
};

/**
 * 设置页：左侧导航 + 右侧卡片列表。
 *
 * 字体与字号都是下拉点选（一次一个离散动作），即时生效 —— 不会像文本
 * 输入那样每敲一个字符就触发一次终端重排，又卡又闪。
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
  const cursorList = useMemo(
    () => cursorStyleOptions(t),
    [t]
  );
  const scrollbackList = useMemo(
    () =>
      scrollbackOptions(t, settings.scrollback),
    [t, settings.scrollback]
  );
  const [section, setSection] =
    useState<Section>("general");
  // 字号候选：合法区间内的每个像素值一项，选中即生效
  const sizeOptions = useMemo(() => {
    const options: SelectOption<string>[] = [];
    for (
      let size = MIN_FONT_SIZE;
      size <= MAX_FONT_SIZE;
      size++
    ) {
      options.push({
        value: String(size),
        label: String(size)
      });
    }
    return options;
  }, []);

  // 本机字体清单：来自后端的 GDI 枚举，用与主题一致的自绘下拉全量列出。
  // 不用 <datalist> —— 它按输入框文字过滤候选，选中字体后菜单就只剩
  // 匹配它的一项，想换字体得先把输入框删干净
  const [fonts, setFonts] = useState<string[]>(
    []
  );

  useEffect(() => {
    invoke<string[]>("list_fonts")
      // 后端异常时兜底空数组：invoke 链路若 resolve 了 null，
      // 直接 setFonts 会让字体下拉的 map 崩掉整个设置页
      .then(fonts => setFonts(fonts ?? []))
      .catch(() => {});
  }, []);

  // 字体下拉选项：「默认」项（存空串）置顶；历史手输的字体栈不在枚举里
  // 时补进去，免得触发器显示成「默认」
  const fontOptions = useMemo(() => {
    const options: SelectOption<string>[] =
      fonts.map(name => ({
        value: name,
        label: name
      }));
    if (
      settings.fontFamily &&
      !fonts.includes(settings.fontFamily)
    ) {
      options.unshift({
        value: settings.fontFamily,
        label: settings.fontFamily
      });
    }
    return [
      {
        value: "",
        label: t("settings.font.default", {
          name: firstFontOf(
            TERMINAL_FONT_FALLBACK
          )
        })
      },
      ...options
    ];
  }, [fonts, settings.fontFamily, t]);

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
        <button
          type="button"
          className={
            section === "colorScheme"
              ? "settings-nav-item is-active"
              : "settings-nav-item"
          }
          onClick={() =>
            setSection("colorScheme")
          }
        >
          <FormatPainterOutlined />
          {t("settings.nav.colorScheme")}
        </button>
        <button
          type="button"
          className={
            section === "models"
              ? "settings-nav-item is-active"
              : "settings-nav-item"
          }
          onClick={() => setSection("models")}
        >
          <ApiOutlined />
          {t("settings.nav.models")}
        </button>
        <button
          type="button"
          className={
            section === "shortcuts"
              ? "settings-nav-item is-active"
              : "settings-nav-item"
          }
          onClick={() => setSection("shortcuts")}
        >
          <KeyOutlined />
          {t("settings.nav.shortcuts")}
        </button>
      </aside>

      <section className="settings-content">
        <h1 className="settings-title">
          {
            {
              general: t("settings.nav.general"),
              terminal: t(
                "settings.nav.terminal"
              ),
              colorScheme: t(
                "settings.nav.colorScheme"
              ),
              models: t("settings.nav.models"),
              shortcuts: t(
                "settings.nav.shortcuts"
              )
            }[section]
          }
        </h1>
        {section !== "models" && (
          <p className="settings-subtitle">
            {t("settings.subtitle")}
          </p>
        )}

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
        ) : section === "terminal" ? (
          <>
            <SettingsRow
              title={t("settings.font.title")}
              description={t(
                "settings.font.desc"
              )}
              control={
                <SettingsSelect
                  value={settings.fontFamily}
                  options={fontOptions}
                  ariaLabel={t(
                    "settings.font.title"
                  )}
                  onChange={fontFamily =>
                    onChange({ fontFamily })
                  }
                />
              }
            />

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
                <SettingsSelect
                  value={String(
                    settings.fontSize
                  )}
                  options={sizeOptions}
                  ariaLabel={t(
                    "settings.fontSize.title"
                  )}
                  onChange={size =>
                    onChange({
                      fontSize: Number(size)
                    })
                  }
                />
              }
            />

            <SettingsRow
              title={t(
                "settings.scrollback.title"
              )}
              description={t(
                "settings.scrollback.desc"
              )}
              control={
                <SettingsSelect
                  value={String(
                    settings.scrollback
                  )}
                  options={scrollbackList}
                  ariaLabel={t(
                    "settings.scrollback.title"
                  )}
                  onChange={lines =>
                    onChange({
                      scrollback: Number(lines)
                    })
                  }
                />
              }
            />

            <SettingsRow
              title={t("settings.cursor.title")}
              description={t(
                "settings.cursor.desc"
              )}
              control={
                <SettingsSelect
                  value={settings.cursorStyle}
                  options={cursorList}
                  ariaLabel={t(
                    "settings.cursor.title"
                  )}
                  onChange={cursorStyle =>
                    onChange({ cursorStyle })
                  }
                />
              }
            />

            <SettingsRow
              title={t(
                "settings.cursorBlink.title"
              )}
              description={t(
                "settings.cursorBlink.desc"
              )}
              control={
                <Toggle
                  ariaLabel={t(
                    "settings.cursorBlink.title"
                  )}
                  isSelected={
                    settings.cursorBlink
                  }
                  onChange={cursorBlink =>
                    onChange({ cursorBlink })
                  }
                />
              }
            />

            <SettingsRow
              title={t("settings.welcome.title")}
              description={t(
                "settings.welcome.desc"
              )}
              control={
                <Toggle
                  ariaLabel={t(
                    "settings.welcome.title"
                  )}
                  isSelected={
                    settings.welcomeCard
                  }
                  onChange={welcomeCard =>
                    onChange({ welcomeCard })
                  }
                />
              }
            />

            <SettingsRow
              title={t(
                "settings.completion.title"
              )}
              description={t(
                "settings.completion.desc"
              )}
              control={
                <Toggle
                  ariaLabel={t(
                    "settings.completion.title"
                  )}
                  isSelected={
                    settings.commandCompletion
                  }
                  onChange={commandCompletion =>
                    onChange({
                      commandCompletion
                    })
                  }
                />
              }
            />
          </>
        ) : section === "shortcuts" ? (
          <ShortcutSettings
            overrides={settings.shortcutOverrides}
            onChange={shortcutOverrides =>
              onChange({ shortcutOverrides })
            }
          />
        ) : section === "colorScheme" ? (
          <SettingsRow
            title={t(
              "settings.colorScheme.title"
            )}
            titleExtra={
              resolveColorScheme(
                settings.colorScheme
              ).name
            }
            description={t(
              "settings.colorScheme.desc"
            )}
          >
            <ColorSchemePicker
              value={settings.colorScheme}
              onChange={colorScheme =>
                onChange({ colorScheme })
              }
            />
          </SettingsRow>
        ) : (
          <ModelProvidersPage />
        )}
      </section>
    </div>
  );
}
