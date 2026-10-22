import { logWarn } from "@/shared/lib/log";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import SettingsRow from "@/settings/components/SettingsRow";
import Toggle from "@/shared/components/Toggle";
import type { AppSettings } from "@/settings/lib/settings";
import {
  checkProxyUrl,
  PROXY_EXAMPLES
} from "@/settings/lib/proxyUrl";

type ProxyRowProps = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
};

/** 后端 `app_proxy_test` 的返回结构（见 infra::proxy::ProxyTestResult）。 */
type ProxyTestResult = {
  ok: boolean;
  connected: boolean;
  status?: number;
  elapsedMs: number;
  error?: string;
};

/**
 * 连通性测试的结果（对应后端 `ProxyTestResult`）。
 *
 * ⚠️ `connected` 与 `ok` 必须分开存，不能压成一个「成功/失败」：
 * 「连上了但探测端点返回非 2xx」说明**代理是通的**，把它显示成失败
 * 会把用户引去查代理配置，而问题其实不在那儿。
 */
type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | {
      kind: "done";
      ok: boolean;
      connected: boolean;
      status?: number;
      elapsedMs: number;
      error?: string;
    };

/**
 * 设置页的「网络代理」一项：开关 + 地址 + 连通性测试，同一张卡片。
 *
 * ## 地址区为什么在关闭时整个不渲染，而不是置灰
 *
 * 置灰会让用户以为「地址填错了所以不能编辑」，其实关掉代理与地址本身
 * 无关。干脆不渲染 —— 卡片回到最简的一行开关，视觉上就是「这功能
 * 没开」，不用读任何解释。
 *
 * ## 关掉开关不清地址
 *
 * 地址保留在设置里：代理软件没开、或临时想直连时不必重填
 * （开回来就能用）。这与「数据存储路径」那类"改地址=搬数据"的
 * 配置不同 —— 代理地址只是一段待用字符串，清掉没有收益。
 *
 * ## 地址为什么不失焦就校验
 *
 * 输入框**边打边存**（每次 change 都写设置），校验结果只用于显示提示，
 * 不阻止输入 —— 用户在打 `127.0.0.` 的过程中如果被拦着不让继续，
 * 是很别扭的。真正「用不了」的情况由 Rust 侧兜底：代理地址非法时
 * 自动退回直连并在日志里 warn，一个填错的代理不至于让 AI 彻底连不上。
 */
export default function ProxyRow({
  settings,
  onChange
}: ProxyRowProps) {
  const t = useT();
  const [test, setTest] = useState<TestState>({
    kind: "idle"
  });
  const enabled = settings.proxyEnabled;
  const check = checkProxyUrl(settings.proxyUrl);

  /**
   * 测一下输入框里这个地址能不能用。
   *
   * 传 `proxyUrl` 而不是让后端读设置：测试的语义是「这个代理行不行」，
   * 与开关当前是开是关无关（关着开关点测试必然失败，那结论没用）。
   * 网络层失败由后端用 `connected: false` 表达，不走 reject —— 前端要
   * 区分「连不上」和「连上了但端点不给好脸色」，靠解析错误文本太脆。
   */
  async function runTest() {
    setTest({ kind: "testing" });
    try {
      const result =
        await invoke<ProxyTestResult>(
          "app_proxy_test",
          {
            proxy: {
              enabled: true,
              url: settings.proxyUrl
            }
          }
        );
      console.info(
        "[settings] 代理连通性测试结果",
        result
      );
      setTest({
        kind: "done",
        ok: result.ok,
        connected: result.connected,
        status: result.status,
        elapsedMs: result.elapsedMs,
        error: result.error
      });
    } catch (reason) {
      // 只有客户端构建失败才会到这里（后端其他失败都返回结构）
      logWarn(
        "[settings] 代理连通性测试异常",
        reason
      );
      setTest({
        kind: "done",
        ok: false,
        connected: false,
        elapsedMs: 0,
        error: String(reason)
      });
    }
  }

  return (
    <SettingsRow
      title={t("proxy.title")}
      description={t("proxy.desc")}
      titleExtra={
        enabled && check.ok ? (
          <span className="proxy-summary">
            {check.url}
          </span>
        ) : null
      }
      control={
        <Toggle
          ariaLabel={t("proxy.enable")}
          isSelected={enabled}
          onChange={proxyEnabled =>
            onChange({ proxyEnabled })
          }
        />
      }
    >
      {enabled && (
        <>
          <div className="proxy-field">
            <input
              className="settings-input proxy-input"
              value={settings.proxyUrl}
              spellCheck={false}
              aria-label={t("proxy.url")}
              placeholder={t(
                "proxy.urlPlaceholder"
              )}
              onChange={event => {
                // 换地址即作废旧测试结果：那条结论描述的是上一个代理
                setTest({ kind: "idle" });
                onChange({
                  proxyUrl: event.target.value
                });
              }}
            />
            {PROXY_EXAMPLES.map(example => (
              <button
                key={example.url}
                type="button"
                className="proxy-example"
                onClick={() => {
                  setTest({ kind: "idle" });
                  onChange({
                    proxyUrl: example.url
                  });
                }}
              >
                {example.label}
              </button>
            ))}
            <Button
              variant="tertiary"
              size="sm"
              className="proxy-test"
              // 测试进行中禁掉按钮即可：HeroUI v3 的 Button 没有
              // isLoading 属性，忙碌态靠文案体现
              isDisabled={
                !check.ok ||
                test.kind === "testing"
              }
              onPress={runTest}
            >
              {test.kind === "testing"
                ? t("proxy.testing")
                : t("proxy.test")}
            </Button>
          </div>

          {!check.ok &&
            settings.proxyUrl.trim() && (
              <p className="proxy-message is-error">
                {t(
                  `proxy.invalid.${check.reason}`
                )}
              </p>
            )}
          {test.kind === "done" &&
            test.connected && (
              // 连上了：即使状态码非 2xx 也算代理可用，弱色说明即可，
              // 别用红色把用户引去查代理配置
              <p
                className={
                  test.ok
                    ? "proxy-message is-ok"
                    : "proxy-message"
                }
              >
                {test.ok
                  ? t("proxy.status.ok", {
                      ms: test.elapsedMs
                    })
                  : t("proxy.status.reachable", {
                      status: test.status ?? 0
                    })}
              </p>
            )}
          {test.kind === "done" &&
            !test.connected && (
              <p className="proxy-message is-error">
                {t("proxy.status.fail")}
                {test.error ?? ""}
              </p>
            )}
          <p className="proxy-hint">
            {t("proxy.hint.storage")}
          </p>
        </>
      )}
    </SettingsRow>
  );
}
