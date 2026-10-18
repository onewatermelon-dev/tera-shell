import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn()
}));

import {
  LICENSE_ENTRIES,
  compareVersions,
  filterLicenses,
  groupByLicense,
  isNewerVersion,
  parseRelease,
  REPO_URL
} from "@/settings/lib/about";

describe("版本比对", () => {
  it("主次修订按数字比（1.10 > 1.9，不是字符串序）", () => {
    expect(
      compareVersions("1.10.0", "1.9.0")
    ).toBe(1);
    expect(
      compareVersions("1.9.0", "1.10.0")
    ).toBe(-1);
    expect(
      isNewerVersion("v1.10.0", "1.9.0")
    ).toBe(true);
  });

  it("缺位补 0：1.2 == 1.2.0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(
      0
    );
    expect(compareVersions("1.2.0", "1.2")).toBe(
      0
    );
  });

  it("前导 v 忽略", () => {
    expect(
      compareVersions("v2.0.0", "2.0.0")
    ).toBe(0);
    expect(
      compareVersions("V2.0.0", "2.0.0")
    ).toBe(0);
  });

  it("预发布版小于同号正式版", () => {
    expect(
      compareVersions("1.0.0-beta.1", "1.0.0")
    ).toBe(-1);
    expect(
      compareVersions("1.0.0", "1.0.0-rc.2")
    ).toBe(1);
    expect(
      isNewerVersion("1.0.0", "1.0.0-beta.9")
    ).toBe(true);
  });

  it("相同版本不算更新", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(
      false
    );
  });

  it("脏数据不炸：非法段当 0", () => {
    expect(
      compareVersions("1.x.0", "1.0.0")
    ).toBe(0);
    expect(
      Number.isFinite(
        compareVersions("", "1.0.0")
      )
    ).toBe(true);
  });
});

describe("Release 解析", () => {
  it("正常响应", () => {
    const release = parseRelease({
      tag_name: "v1.2.0",
      html_url:
        "https://github.com/x/y/releases/tag/v1.2.0",
      published_at: "2026-10-01T00:00:00Z",
      body: "修复若干问题"
    });
    expect(release).toEqual({
      version: "1.2.0",
      url: "https://github.com/x/y/releases/tag/v1.2.0",
      publishedAt: "2026-10-01T00:00:00Z",
      notes: "修复若干问题"
    });
  });

  it("结构不对返回 null（限流/404 的响应体）", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({})).toBeNull();
    expect(
      parseRelease({ message: "API rate limit" })
    ).toBeNull();
    expect(
      parseRelease({ tag_name: "  " })
    ).toBeNull();
  });

  it("缺 html_url 时回落到发布列表页", () => {
    const release = parseRelease({
      tag_name: "v9"
    });
    expect(release?.url).toContain("/releases");
  });
});

describe("许可清单", () => {
  it("数据文件有内容且字段齐全", () => {
    expect(
      LICENSE_ENTRIES.length
    ).toBeGreaterThan(50);
    for (const entry of LICENSE_ENTRIES.slice(
      0,
      20
    )) {
      expect(entry.name).toBeTruthy();
      expect(entry.version).toBeTruthy();
      expect(entry.license).toBeTruthy();
    }
  });

  it("按名称排序（便于查找）", () => {
    const names = LICENSE_ENTRIES.map(
      i => i.name
    );
    expect(names).toEqual(
      [...names].sort((a, b) =>
        a.localeCompare(b)
      )
    );
  });

  it("许可证分布统计", () => {
    const groups = groupByLicense(
      LICENSE_ENTRIES
    );
    expect(groups.length).toBeGreaterThan(0);
    const total = groups.reduce(
      (sum, group) => sum + group.count,
      0
    );
    expect(total).toBe(LICENSE_ENTRIES.length);
    // 降序：最多的在前
    expect(
      groups[0]!.count
    ).toBeGreaterThanOrEqual(
      groups[groups.length - 1]!.count
    );
    // 这个项目里 MIT 一定是最大头
    expect(groups[0]!.license).toContain("MIT");
  });

  it("搜索：命中包名与许可证名", () => {
    expect(
      filterLicenses(LICENSE_ENTRIES, "react")
        .length
    ).toBeGreaterThan(0);
    const apa = filterLicenses(
      LICENSE_ENTRIES,
      "apache"
    );
    expect(apa.length).toBeGreaterThan(0);
    expect(
      apa.every(entry =>
        entry.license
          .toLowerCase()
          .includes("apache")
      )
    ).toBe(true);
    expect(
      filterLicenses(LICENSE_ENTRIES, "  ")
    ).toHaveLength(LICENSE_ENTRIES.length);
    expect(
      filterLicenses(LICENSE_ENTRIES, "不存在xyz")
    ).toHaveLength(0);
  });
});

describe("关于页渲染与接线", () => {
  it("渲染版本号、更新入口与许可清单", async () => {
    const { AboutSection } =
      await import("@/settings/components/AboutSection");
    const html = renderToStaticMarkup(
      createElement(AboutSection)
    );
    expect(html).toContain("tera-shell");
    // 版本号：构建期注入，测试环境走兜底
    expect(html).toMatch(/v\d+\.\d+\.\d+/);
    expect(html).toContain("about.update.check");
    expect(html).toContain(
      "about.licenses.title"
    );
    // ⚠️ 全量渲染，不截断：曾经只画前 80 条，用户以为后面的丢了
    expect(html.match(/<li/g) ?? []).toHaveLength(
      LICENSE_ENTRIES.length
    );
    expect(
      LICENSE_ENTRIES.length
    ).toBeGreaterThan(80);
  }, 60_000);

  it("设置页注册了关于分区与导航项", async () => {
    const src = (
      await import("@/settings/components/SettingsPage.tsx?raw")
    ).default;
    expect(src).toContain("AboutSection");
    expect(src).toContain('"about"');
    expect(src).toContain("settings.nav.about");
    // 关于页不显示「设置」副标题（它是信息页，不是配置页）
    expect(src).toContain('section !== "about"');
  });

  it("版本号从 tauri.conf.json 注入，不在运行时读", async () => {
    const vite = (
      await import("../../vite.config.ts?raw")
    ).default;
    expect(vite).toContain("__APP_VERSION__");
    expect(vite).toContain(
      "src-tauri/tauri.conf.json"
    );
  });

  it("仓库地址正确", () => {
    expect(REPO_URL).toBe(
      "https://github.com/onewatermelon-dev/tera-shell"
    );
  });
});
