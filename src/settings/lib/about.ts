/**
 * 「关于」页的数据与纯逻辑：版本比对、Release 解析、许可清单整理。
 *
 * 抽出来是因为这些都能在 node 环境单测（没有 DOM）：检查更新最容易出
 * 错的就是**版本比对**（`v1.10` vs `v1.9`、预发布版），用正则或
 * `parseFloat` 比都会翻车。
 */

import licenseData from "./licenses.generated.json";

/** 一个开源组件条目（由 scripts/gen-licenses.mjs 生成）。 */
export type LicenseEntry = {
  name: string;
  version: string;
  license: string;
};

/** 仓库与发布页（检查更新失败时给用户的落脚点）。 */
export const REPO_URL =
  "https://github.com/onewatermelon-dev/tera-shell";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const RELEASES_API = `https://api.github.com/repos/onewatermelon-dev/tera-shell/releases/latest`;

/** 应用名（关于页标题、诊断信息都用它）。 */
export const APP_NAME = "tera-shell";

/** 生成好的许可清单（225 个运行时依赖）。 */
export const LICENSE_ENTRIES =
  licenseData as LicenseEntry[];

/**
 * 版本比对：返回 -1 / 0 / 1。
 *
 * 规则按 semver 的常见子集实现：
 * - 去掉前导 `v`；
 * - 主次修订按**数字**比（`1.10 > 1.9`，字符串比会反）；
 * - 带预发布后缀（`-beta.1`）的**小于**同号正式版。
 */
export function compareVersions(
  left: string,
  right: string
): number {
  const parse = (raw: string) => {
    const trimmed = raw.trim().replace(/^v/i, "");
    const [core, ...rest] = trimmed.split("-");
    const numbers = (core ?? "")
      .split(".")
      .map(part => Number.parseInt(part, 10))
      .map(value =>
        Number.isFinite(value) ? value : 0
      );
    return {
      numbers,
      pre: rest.join("-")
    };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(
    a.numbers.length,
    b.numbers.length
  );
  for (
    let index = 0;
    index < length;
    index += 1
  ) {
    const x = a.numbers[index] ?? 0;
    const y = b.numbers[index] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 主版本相同：有预发布后缀的更旧
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre === b.pre) return 0;
  return a.pre > b.pre ? 1 : -1;
}

/** 远端版本是否比当前更新。 */
export function isNewerVersion(
  latest: string,
  current: string
): boolean {
  return compareVersions(latest, current) > 0;
}

/** 解析后的发布信息。 */
export type ReleaseInfo = {
  version: string;
  url: string;
  publishedAt: string;
  notes: string;
};

/**
 * 解析 GitHub `/releases/latest` 响应。
 *
 * 结构不对一律返回 null —— 检查更新失败是很正常的事（离线、被墙、
 * 触发限流），不该让页面炸。
 */
export function parseRelease(
  data: unknown
): ReleaseInfo | null {
  if (!data || typeof data !== "object")
    return null;
  const obj = data as Record<string, unknown>;
  const tag = obj.tag_name;
  if (typeof tag !== "string" || !tag.trim())
    return null;
  return {
    version: tag.trim().replace(/^v/i, ""),
    url:
      typeof obj.html_url === "string"
        ? obj.html_url
        : RELEASES_URL,
    publishedAt:
      typeof obj.published_at === "string"
        ? obj.published_at
        : "",
    notes:
      typeof obj.body === "string"
        ? obj.body.slice(0, 4000)
        : ""
  };
}

/** 许可证分布：`MIT×186` 这种概览用。 */
export function groupByLicense(
  entries: LicenseEntry[]
): { license: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(
      entry.license,
      (counts.get(entry.license) ?? 0) + 1
    );
  return [...counts.entries()]
    .map(([license, count]) => ({
      license,
      count
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.license.localeCompare(b.license)
    );
}

/** 许可清单搜索：组件名或许可证名都能命中。 */
export function filterLicenses(
  entries: LicenseEntry[],
  query: string
): LicenseEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    entry =>
      entry.name.toLowerCase().includes(needle) ||
      entry.license.toLowerCase().includes(needle)
  );
}
