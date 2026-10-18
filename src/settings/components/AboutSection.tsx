"use client";

/**
 * 设置 · 关于：版本号、检查更新、开源许可清单。
 *
 * 三个刻意的取舍：
 * - **版本号走构建期注入**（`__APP_VERSION__`，源头是 tauri.conf.json），
 *   不在运行时申请 Tauri 的 app 权限 —— 少一条 capability，也少一个
 *   能失败的点；
 * - **检查更新是"查 + 跳转"，不做静默自动升级**：自动更新要签名密钥、
 *   更新端点、回滚方案，属于另一条工程线；这里只回答「有没有新版」，
 *   然后把人送到发布页；
 * - **失败必须给出路**：国内直连 api.github.com 经常被打断，所以检查
 *   失败时不是一句"检查失败"，而是把版本、原因和发布页链接一起给出。
 */

import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "@/settings/lib/i18n";
import {
  APP_NAME,
  LICENSE_ENTRIES,
  RELEASES_API,
  RELEASES_URL,
  REPO_URL,
  filterLicenses,
  groupByLicense,
  isNewerVersion,
  parseRelease,
  type ReleaseInfo
} from "@/settings/lib/about";
import styles from "./AboutSection.module.css";

/**
 * 版本号：构建期注入。
 * ⚠️ 测试环境没有 define，用 `typeof` 守卫（对未声明标识符安全），
 * 否则组件在单测里会抛 ReferenceError。
 */
const APP_VERSION =
  typeof __APP_VERSION__ === "string"
    ? __APP_VERSION__
    : "0.0.0";

/** 检查更新的四种结果。 */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "newer"; release: ReleaseInfo }
  | { kind: "failed"; reason: string };

/**
 * 许可清单**全量渲染**，不分页。
 *
 * 一开始按 80 条截断（怕 225 个 <li> 拖慢首屏），实测是多虑：整个列表
 * 有 max-height 内部滚动，225 行 DOM 对 Chromium 不值一提，反而让人
 * 以为「后面的没显示」（2026-10-18 用户直接问了这个）。
 * 真到几千条再考虑虚拟滚动。
 */

export function AboutSection() {
  const t = useT();
  const [update, setUpdate] =
    useState<UpdateState>({
      kind: "idle"
    });
  const [query, setQuery] = useState("");

  const licenses = useMemo(
    () => filterLicenses(LICENSE_ENTRIES, query),
    [query]
  );
  const groups = useMemo(
    () => groupByLicense(LICENSE_ENTRIES),
    []
  );

  /** 打开外链：失败只记日志，不打断（系统没有默认浏览器时才会走到）。 */
  function open(url: string) {
    void openUrl(url).catch(reason =>
      console.error(
        "[about] 打开链接失败",
        url,
        reason
      )
    );
  }

  /**
   * 查 GitHub 最新 release 并比对版本。
   *
   * 8 秒超时：没有超时的话，网络被静默丢包时按钮会一直"检查中"。
   */
  async function checkUpdate() {
    setUpdate({ kind: "checking" });
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => controller.abort(),
      8000
    );
    try {
      const response = await fetch(RELEASES_API, {
        headers: {
          Accept: "application/vnd.github+json"
        },
        signal: controller.signal
      });
      if (!response.ok) {
        // 403 = 触发限流，404 = 还没有 release，都比较常见
        console.warn(
          "[about] 检查更新失败，HTTP",
          response.status
        );
        setUpdate({
          kind: "failed",
          reason: `HTTP ${response.status}`
        });
        return;
      }
      const release = parseRelease(
        await response.json()
      );
      if (!release) {
        setUpdate({
          kind: "failed",
          reason: t("about.update.badPayload")
        });
        return;
      }
      console.info(
        "[about] 最新版本：",
        release.version,
        "当前：",
        APP_VERSION
      );
      setUpdate(
        isNewerVersion(
          release.version,
          APP_VERSION
        )
          ? { kind: "newer", release }
          : { kind: "latest" }
      );
    } catch (reason) {
      console.warn(
        "[about] 检查更新异常",
        reason
      );
      setUpdate({
        kind: "failed",
        reason:
          reason instanceof Error &&
          reason.name === "AbortError"
            ? t("about.update.timeout")
            : t("about.update.network")
      });
    } finally {
      window.clearTimeout(timer);
    }
  }

  const updateText =
    update.kind === "checking"
      ? t("about.update.checking")
      : update.kind === "latest"
        ? t("about.update.latest")
        : update.kind === "newer"
          ? `${t("about.update.newer")} v${update.release.version}`
          : update.kind === "failed"
            ? `${t("about.update.failed")}（${update.reason}）`
            : t("about.update.hint");

  return (
    <div className={styles.stack}>
      {/* ---- 应用信息 ---- */}
      <div className={styles.card}>
        <div className={styles.appHead}>
          <span className={styles.appName}>
            {APP_NAME}
          </span>
          <span className={styles.version}>
            v{APP_VERSION}
          </span>
        </div>
        <p className={styles.desc}>
          {t("about.desc")}
        </p>
      </div>

      {/* ---- 版本更新 ---- */}
      <div className={styles.card}>
        <div className={styles.rowHead}>
          <span className={styles.rowTitle}>
            {t("about.update.title")}
          </span>
          <button
            type="button"
            className={styles.action}
            disabled={update.kind === "checking"}
            onClick={() => void checkUpdate()}
          >
            {update.kind === "checking"
              ? t("about.update.checking")
              : t("about.update.check")}
          </button>
        </div>
        <p
          className={styles.hint}
          data-tone={
            update.kind === "newer"
              ? "good"
              : update.kind === "failed"
                ? "bad"
                : undefined
          }
        >
          {updateText}
        </p>
        <div className={styles.linkRow}>
          {update.kind === "newer" && (
            <button
              type="button"
              className={styles.link}
              onClick={() =>
                open(update.release.url)
              }
            >
              {t("about.update.openRelease")}
            </button>
          )}
          <button
            type="button"
            className={styles.link}
            onClick={() => open(RELEASES_URL)}
          >
            {t("about.update.allReleases")}
          </button>
          <button
            type="button"
            className={styles.link}
            onClick={() => open(REPO_URL)}
          >
            {t("about.repo")}
          </button>
        </div>
      </div>

      {/* ---- 开源许可 ---- */}
      <div className={styles.card}>
        <div className={styles.rowHead}>
          <span className={styles.rowTitle}>
            {t("about.licenses.title")}
            <span className={styles.badge}>
              {LICENSE_ENTRIES.length}
            </span>
          </span>
          <input
            className={styles.search}
            value={query}
            placeholder={t(
              "about.licenses.search"
            )}
            aria-label={t(
              "about.licenses.search"
            )}
            onChange={event =>
              setQuery(event.target.value)
            }
          />
        </div>
        <p className={styles.groups}>
          {groups
            .map(
              group =>
                `${group.license} ${group.count}`
            )
            .join(" · ")}
        </p>
        <ul className={styles.licenseList}>
          {licenses.map(entry => (
            <li
              key={`${entry.name}@${entry.version}`}
              className={styles.licenseItem}
            >
              <span
                className={styles.licenseName}
              >
                {entry.name}
              </span>
              <span
                className={styles.licenseMeta}
              >
                {entry.version} · {entry.license}
              </span>
            </li>
          ))}
        </ul>
        {licenses.length === 0 && (
          <p className={styles.hint}>
            {t("about.licenses.empty")}
          </p>
        )}
      </div>
    </div>
  );
}
