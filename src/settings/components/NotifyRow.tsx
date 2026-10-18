import { useState } from "react";
import { Button } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import SettingsRow from "@/settings/components/SettingsRow";
import Toggle from "@/shared/components/Toggle";
import type { AppSettings } from "@/settings/lib/settings";
import { sendTestNotification } from "@/lib/notifySend";

type NotifyRowProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * 设置页的「系统通知」一张卡片：总开关 + 三个分类开关 + 测试按钮。
 *
 * 分类开关在总开关关闭时置灰（而不是隐藏）：隐藏会让用户以为
 * 「这三个选项不存在」，而置灰保留了「关掉总开关后它们会自动回来」
 * 的预期。
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
  const [test, setTest] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * 发一条测试通知：**绕过所有判定**（开关、焦点、阈值都不看）。
   *
   * 存在的意义是把「环境/权限问题」与「触发条件没满足」一次分开：
   * 测试能弹 → 通路正常，长命令不弹就得去查计时器与阈值；
   * 测试也不弹 → 与本功能无关，是 WebView2 的宿主通知开关或权限问题。
   * 没有这个按钮，两种情况都表现为「没弹」，排查只能靠猜。
   */
  async function runTest() {
    setBusy(true);
    setTest("");
    try {
      const result = await sendTestNotification();
      // 两种失败的修法完全不同，必须分开说：
      // unsupported = WebView2 关了宿主通知，改设置没用；
      // denied = 用户点过拒绝，能在系统设置里重新允许
      setTest(
        result.ok
          ? t("notify.testSent")
          : result.reason === "unsupported"
            ? t("notify.testUnsupported")
            : t("notify.testDenied")
      );
    } finally {
      setBusy(false);
    }
  }

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
      <div className="notify-kinds">
        <Toggle
          ariaLabel={t("notify.command")}
          isSelected={settings.notifyCommand}
          isDisabled={!on}
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
          isDisabled={!on}
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
          isDisabled={!on}
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

      <div className="notify-test">
        <Button
          variant="tertiary"
          size="sm"
          isDisabled={busy}
          onPress={runTest}
        >
          {busy
            ? t("proxy.testing")
            : t("notify.test")}
        </Button>
        {test && (
          <p className="notify-test-result">
            {test}
          </p>
        )}
        <p className="notify-kind-hint">
          {t("notify.testHint")}
        </p>
      </div>
    </SettingsRow>
  );
}
