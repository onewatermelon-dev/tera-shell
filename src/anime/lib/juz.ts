/**
 * 聚站（juzong01.me，苹果CMS stui 模板）的页面解析层。
 *
 * 与参考 App 的加密 API 不同，这个站是**服务端渲染 HTML**，没有独立接口：
 * 首页/搜索/详情的数据都在页面里，播放页内嵌明文 `var player_data={...}`
 * JSON（encrypt=0，url 即 m3u8 直链）。取页走后端 `juz_get`（cookie 两连发
 * 过 WAF），解析在前端用 DOMParser 完成。
 *
 * 页面结构（2026-11 实抓）：
 * - 卡片：`a.stui-vodlist__thumb[href=/voddetail/{id}/]` + title/data-original/pic-text
 * - 详情：`h1.title`、`.stui-content__detail p.data`、简介 `.detail-sketch`
 * - 剧集：多个 `ul.stui-content__playlist`（每条线路一个 UL），li>a 是单集
 * - 播放：`var player_data={flag,encrypt,url,url_next,link_next,...}`
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AnimeDetail,
  AnimeEpisode,
  AnimeVideo
} from "./types";

const BASE = "https://www.juzong01.me";

/** 取一页并解析成 DOM（juz_get 负责 WAF 两连发）。 */
async function page(
  path: string
): Promise<Document> {
  const html = await invoke<string>("juz_get", {
    url: BASE + path
  });
  return new DOMParser().parseFromString(
    html,
    "text/html"
  );
}

/** 单个卡片锚 → AnimeVideo；id 直接存 voddetail 路径（详情/播放都靠它）。 */
function parseCard(
  anchor: HTMLAnchorElement
): AnimeVideo | null {
  const path = anchor.getAttribute("href") ?? "";
  // 详情页里也有同类锚（推荐位），非 /voddetail/{id}/ 的一律跳过
  if (!/^\/voddetail\/\d+\/$/.test(path))
    return null;
  const title = (
    anchor.getAttribute("title") ||
    anchor.textContent ||
    ""
  ).trim();
  if (!title) return null;
  const badge = anchor
    .querySelector(".pic-text")
    ?.textContent?.trim();
  return {
    id: path,
    title,
    posterUrl:
      anchor.getAttribute("data-original") ||
      anchor.getAttribute("data-src") ||
      "",
    badgeTag: badge || undefined,
    isFinished: badge
      ? badge.includes("完结")
      : undefined
  };
}

/** 卡片 → AnimeVideo：id 直接存 voddetail 路径（详情/播放都靠它拼 URL）。 */
function cards(
  doc: Document,
  selector = "a.stui-vodlist__thumb"
): AnimeVideo[] {
  const out: AnimeVideo[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll(selector).forEach(el => {
    const anchor = el as HTMLAnchorElement;
    const card = parseCard(anchor);
    if (!card || seen.has(card.id)) return;
    seen.add(card.id);
    out.push(card);
  });
  return out;
}

/** 频道导航项（首页顶部 nav 的分类链接）。 */
export type JuzNavItem = {
  path: string;
  title: string;
};

/**
 * 首页：卡片 + 频道导航（一次抓取两个产出）。
 */
/** 首页板块：板块标题 + 该板块的卡片（首页按题材分区展示用）。 */
export type JuzSection = {
  title: string;
  videos: AnimeVideo[];
};

export async function juzHome(): Promise<{
  videos: AnimeVideo[];
  nav: JuzNavItem[];
  sections: JuzSection[];
}> {
  const doc = await page("/");
  const nav: JuzNavItem[] = [];
  const seenNav = new Set<string>();
  doc
    .querySelectorAll("a[href^='/vodtype/']")
    .forEach(el => {
      const anchor = el as HTMLAnchorElement;
      const path =
        anchor.getAttribute("href") ?? "";
      const title =
        anchor.textContent?.trim() ?? "";
      // 首页 nav 每类只留一条；板块里重复的引用跳过
      if (
        !/^\/vodtype\/\d+\/$/.test(path) ||
        !title ||
        seenNav.has(path)
      ) {
        return;
      }
      seenNav.add(path);
      nav.push({ path, title });
    });
  // 频道栏只留这四个（产品定稿）；「剧集」按用户习惯显示为「电视剧」
  const KEEP = new Map([
    ["/vodtype/2/", "电视剧"],
    ["/vodtype/3/", "综艺"],
    ["/vodtype/4/", "动漫"]
  ]);
  const keptNav = nav
    .filter(item => KEEP.has(item.path))
    .map(item => ({
      ...item,
      title: KEEP.get(item.path) as string
    }));
  // 板块：每个 stui-pannel 一组（标题 + 组内卡片，组内去重）
  const sections: JuzSection[] = [];
  doc
    .querySelectorAll(".stui-pannel")
    .forEach(pannel => {
      const title = pannel
        .querySelector("h3.title")
        ?.textContent?.trim();
      if (!title) return;
      const videos: AnimeVideo[] = [];
      const seen = new Set<string>();
      pannel
        .querySelectorAll("a.stui-vodlist__thumb")
        .forEach(el => {
          const card = parseCard(
            el as HTMLAnchorElement
          );
          if (!card || seen.has(card.id)) return;
          seen.add(card.id);
          videos.push(card);
        });
      if (videos.length) {
        sections.push({ title, videos });
      }
    });
  return {
    videos: cards(doc),
    nav: keptNav,
    sections
  };
}

/** 筛选组：组名（按地区/按年份/排序…）+ 选项。 */
export type JuzScreenGroup = {
  label: string;
  options: JuzNavItem[];
};

/**
 * 列表页（/vodtype/ 分类页与 /vodshow/ 筛选结果页通用）：卡片 + 筛选组。
 */
export async function juzListing(
  path: string
): Promise<{
  videos: AnimeVideo[];
  screens: JuzScreenGroup[];
}> {
  const doc = await page(path);
  const screens: JuzScreenGroup[] = [];
  doc
    .querySelectorAll("ul.stui-screen__list")
    .forEach(ul => {
      const labelEl = ul.querySelector(
        "li > span.text-muted"
      );
      const links: JuzNavItem[] = [];
      ul.querySelectorAll("a[href]").forEach(
        el => {
          const anchor = el as HTMLAnchorElement;
          const href =
            anchor.getAttribute("href") ?? "";
          const title =
            anchor.textContent?.trim() ?? "";
          if (
            !/^\/(vodtype|vodshow)\//.test(
              href
            ) ||
            !title
          ) {
            return;
          }
          links.push({ path: href, title });
        }
      );
      if (links.length) {
        screens.push({
          label:
            labelEl?.textContent?.trim() ||
            "筛选",
          options: links
        });
      }
    });
  return { videos: cards(doc), screens };
}

/** 搜索：苹果CMS 标准 /vodsearch/{关键词}-------------/。 */
export async function juzSearch(
  keyword: string
): Promise<AnimeVideo[]> {
  const path = `/vodsearch/${encodeURIComponent(
    keyword
  )}-------------/`;
  const doc = await page(path);
  // 站点对搜索有 6 秒频控：触发时返回「系统提示」页（0 卡片，之前被装成
  // 「没有内容」）。等 6.5 秒重试一次，仍被限就明确报错。
  if (isThrottled(doc)) {
    await new Promise(resolve =>
      setTimeout(resolve, 6500)
    );
    const retry = await page(path);
    if (isThrottled(retry)) {
      throw new Error(
        "搜索太频繁：站点限制 6 秒一次，稍等再搜"
      );
    }
    return searchHits(retry);
  }
  return searchHits(doc);
}

/** 频控页特征：标题「系统提示」+ 正文提示搜索间隔。 */
function isThrottled(doc: Document): boolean {
  return (
    doc.body.textContent?.includes(
      "搜索时间间隔"
    ) ?? false
  );
}

/**
 * 搜索命中只取 v-thumb 卡片：结果页还有 m-thumb 的「大家还在看」推荐位
 * （同样挂着 stui-vodlist__thumb 类），混进来就是与关键词无关的条目。
 */
function searchHits(doc: Document): AnimeVideo[] {
  return cards(
    doc,
    "a.stui-vodlist__thumb.v-thumb"
  );
}

/** 从一个播放路径抠出集号（/vodplay/13384-1-12/ → 12）。导出供单测锁定。 */
export function epNumberOf(
  playPath: string
): number {
  const m = playPath.match(
    /^\/vodplay\/\d+-\d+-(\d+)\/$/
  );
  return m ? Number(m[1]) : 0;
}

/** 一条播放线路：站点上的一组剧集（dujia* 解析源也在这，播放时才判别能不能直连）。 */
export type JuzLine = {
  /** 线路标题（站点上的中文营销名，如「剧踪独家[热播X]」；参考站合并线路是自定义名） */
  title: string;
  episodes: AnimeEpisode[];
  /** 参考站合并线路才有：参考 App API 的 videoId，播这条线走加密 API 播放链 */
  appVideoId?: string;
};

/**
 * 详情页：元信息 + 全部线路。
 *
 * 站点经常有多达 11 条线路，前几条常是 dujia* 解析源（url 是加密 token，
 * 不是直链）。线路能不能播只有抓了它的播放页才知道，所以这里把**全部
 * 线路**都返回，由播放侧按序探测跳过不可直连的线路（见 juzPlay）。
 */
export async function juzDetail(
  idPath: string
): Promise<{
  video: AnimeDetail;
  lines: JuzLine[];
}> {
  const doc = await page(idPath);
  const title = doc
    .querySelector(
      ".stui-content__detail h1.title"
    )
    ?.textContent?.trim();
  if (!title) {
    throw new Error("详情页解析失败（没有标题）");
  }
  // 详情页海报在 stui-content__thumb 里（⚠️ 不能写 .stui-content——BEM 类名
  // 是完整 token，stui-content__thumb 不匹配 .stui-content，查了就是 null）
  const poster =
    doc
      .querySelector(
        ".stui-content__thumb a.stui-vodlist__thumb img"
      )
      ?.getAttribute("data-original") ||
    doc
      .querySelector(
        ".stui-content__thumb a.stui-vodlist__thumb"
      )
      ?.getAttribute("data-original");
  // p.data 两行：类型/地区/年份、主演/导演
  const dataLines = Array.from(
    doc.querySelectorAll(
      ".stui-content__detail p.data"
    )
  ).map(node =>
    (node.textContent ?? "")
      .replace(
        /类型：|地区：|年份：|主演：|导演：|语言：/g,
        ""
      )
      .replace(/\s+/g, " ")
      .trim()
  );
  const description =
    doc
      .querySelector(".detail-sketch")
      ?.textContent?.trim() ||
    doc
      .querySelector(".detail-content")
      ?.textContent?.trim() ||
    "";
  const video: AnimeDetail = {
    id: idPath,
    title,
    posterUrl: poster ?? "",
    actors: dataLines[1] || undefined,
    tags: dataLines[0] || undefined,
    description
  };

  // 每条线路一个 UL，前面的 h3.title 是线路名
  const lines: JuzLine[] = [];
  doc
    .querySelectorAll("ul.stui-content__playlist")
    .forEach(ul => {
      const list: AnimeEpisode[] = [];
      ul.querySelectorAll(
        "a[href^='/vodplay/']"
      ).forEach((el, index) => {
        const anchor = el as HTMLAnchorElement;
        const path =
          anchor.getAttribute("href") ?? "";
        if (
          !/^\/vodplay\/\d+-\d+-\d+\/$/.test(path)
        ) {
          return;
        }
        list.push({
          // 集号取路径里的段（稳定），缺失时退回出现顺序
          episodeNum:
            epNumberOf(path) || index + 1,
          episodeName:
            anchor.textContent?.trim() ||
            `第 ${index + 1} 集`,
          // code 字段复用为播放页路径（App 源里是取播 code，语义同为「怎么播」）
          code: path
        });
      });
      if (list.length) {
        // 线路名在 UL 所属面板的 h3.title 里；取不到就退成「线路 N」
        const head = ul
          .closest(".stui-pannel")
          ?.querySelector("h3.title")
          ?.textContent?.trim();
        lines.push({
          title:
            head || `线路 ${lines.length + 1}`,
          episodes: list
        });
      }
    });
  if (!lines.length) {
    throw new Error(
      "详情页解析失败（没有剧集线路）"
    );
  }
  return { video, lines };
}

/**
 * 该 URL 是否能直接喂给播放器。
 *
 * dujia* 解析源给的是加密 token（非 http 开头），qq 线给的是网页链接
 * （.html），两者都不能直接播——播放侧按这个判定跳过不可直连的线路。
 */
export function isDirectPlayUrl(
  url: string
): boolean {
  return (
    /^https?:\/\//i.test(url) &&
    !/\.html?($|\?)/i.test(url)
  );
}

/**
 * 从播放页 HTML 抠内嵌 `var player_data={...}`（纯函数，单测用实抓样本锁定）。
 * encrypt=0 是明文直链；非 0 的加密地址明确拒绝（App 端才有对应解密）。
 */
export function parsePlayerData(html: string): {
  playUrl: string;
  nextPath: string | null;
} {
  const m = html.match(
    /var\s+player_data\s*=\s*(\{[\s\S]*?\})\s*<\/script>/
  );
  if (!m) {
    throw new Error(
      "播放页解析失败（没有 player_data）"
    );
  }
  let config: {
    encrypt?: number;
    url?: string;
    url_next?: string;
    link_next?: string;
  };
  try {
    config = JSON.parse(m[1] ?? "{}");
  } catch {
    throw new Error("播放页配置不是合法 JSON");
  }
  if (config.encrypt && config.encrypt !== 0) {
    throw new Error(
      `该集播放地址加密过（encrypt=${config.encrypt}），暂不支持`
    );
  }
  const playUrl = (config.url ?? "").trim();
  if (!playUrl) {
    throw new Error("该集没有可播的地址");
  }
  return {
    playUrl,
    nextPath:
      (config.link_next ?? "").trim() || null
  };
}

/**
 * 解析 dujia* 线路的加密 token，换出真实媒体直链（后端两步复刻站点协议）。
 * 解析失败（线路没有可用地址/区域限制）时抛错，由上层决定换线或提示。
 */
export async function juzResolveToken(
  token: string
): Promise<string> {
  return invoke<string>("juz_resolve_token", {
    token
  });
}

/** 播放页：抠内嵌 player_data JSON，返回 m3u8 直链与下一集路径。 */
export async function juzPlay(
  playPath: string
): Promise<{
  playUrl: string;
  nextPath: string | null;
}> {
  const html = await invoke<string>("juz_get", {
    url: BASE + playPath
  });
  return parsePlayerData(html);
}
