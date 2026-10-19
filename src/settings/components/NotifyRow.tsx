import { useT } from "@/settings/lib/i18n";
import SettingsRow from "@/settings/components/SettingsRow";
import Toggle from "@/shared/components/Toggle";
import type { AppSettings } from "@/settings/lib/settings";

type NotifyRowProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * 设置页的「系统通知」一张卡片：总开关 + 三个分类开关。
 *
 * 分类开关在总开关关闭时**折叠隐藏**（2026-10-19 用户要求，此前是置灰）：
 * 总开关关着时它们本来就不生效，三行灰控件只是视觉噪音。用户自己的
 * 三个开关状态存在设置文件里，重新打开总开关会原样恢复，无需界面上
 * 一直占位。「发一条测试通知」按钮同日移除（用户要求）。
 *
 * 「仅窗口未聚焦时通知」不是开关而是既定行为，写在说明里 ——
 * 这是通知类功能的常识性取舍，给个开关反而会有人打开它然后被吵到。
 */
export default function NotifyRow({
  settings,
  onChange
}: NotifyRowProps) {
  const t = useT();
  const on = settings.notifyEnabled;

  return (
    <SettingsRow
      title={t("notify.title")}
      description={t("notify.desc")}
      control={
        <Toggle
          ariaLabel={t("notify.enable")}
          isSelected={on}
          onChange={notifyEnabled =>
            onChange({ notifyEnabled })
          }
        />
      }
    >
      {on && (
        <>
          <div className="notify-kinds">
            <Toggle
              ariaLabel={t("notify.command")}
              isSelected={settings.notifyCommand}
              onChange={notifyCommand =>
                onChange({ notifyCommand })
              }
            />
            <span className="notify-kind-label">
              {t("notify.command")}
            </span>
            <p className="notify-kind-hint">
              {t("notify.commandHint")}
            </p>
          </div>
          <div className="notify-kinds">
            <Toggle
              ariaLabel={t("notify.ai")}
              isSelected={settings.notifyAi}
              onChange={notifyAi =>
                onChange({ notifyAi })
              }
            />
            <span className="notify-kind-label">
              {t("notify.ai")}
            </span>
            <p className="notify-kind-hint">
              {t("notify.aiHint")}
            </p>
          </div>
          <div className="notify-kinds">
            <Toggle
              ariaLabel={t("notify.transfer")}
              isSelected={settings.notifyTransfer}
              onChange={notifyTransfer =>
                onChange({ notifyTransfer })
              }
            />
            <span className="notify-kind-label">
              {t("notify.transfer")}
            </span>
            <p className="notify-kind-hint">
              {t("notify.transferHint")}
            </p>
          </div>
        </>
      )}
    </SettingsRow>
  );
}
