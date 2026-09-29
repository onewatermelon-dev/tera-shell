import {
  useMemo,
  useState,
  type UIEvent
} from "react";
import { Input } from "@heroui/react";
import { SearchOutlined } from "@ant-design/icons";
import {
  COLOR_SCHEMES,
  resolveColorScheme,
  type ColorScheme
} from "@/terminal/lib/colorSchemes";
import { useT } from "@/settings/lib/i18n";

/** 首批渲染多少张卡片；464 个全量一次挂载会拖慢设置页，靠滚动追加 */
const MAX_VISIBLE = 60;

type PreviewProps = {
  scheme: ColorScheme;
  /** ls 输出的行数（当前方案大预览 5 行，卡片里 3 行） */
  rows?: number;
};

/**
 * 模拟一段 `ls` 输出的方案预览：纯 HTML 着色，不挂 xterm 实例 ——
 * 列表里几十个预览同时跑 xterm 太重，视觉上 HTML 复刻已经够像。
 */
function SchemePreview({
  scheme,
  rows = 5
}: PreviewProps) {
  const c = scheme.ansi;
  const files = [
    { name: "Documents", color: c[3] },
    { name: "Downloads", color: c[2] },
    { name: "Pictures", color: c[4] },
    { name: "Music", color: c[4] }
  ].slice(0, Math.max(0, rows - 1));
  return (
    <div
      className="scheme-preview"
      style={{
        background: scheme.background,
        color: scheme.foreground
      }}
    >
      <div>
        <b style={{ color: c[2] }}>john</b>
        <span style={{ color: c[4] }}>
          @doe-pc
        </span>
        <b style={{ color: c[2] }}>$ </b>
        <span>ls</span>
        <span
          className="scheme-preview-cursor"
          style={{ background: scheme.cursor }}
        />
      </div>
      {files.map(file => (
        <div key={file.name}>
          <span className="scheme-preview-dim">
            -rwxr-xr-x 1 root{" "}
          </span>
          <span style={{ color: file.color }}>
            {file.name}
          </span>
        </div>
      ))}
    </div>
  );
}

type SchemeCardProps = {
  scheme: ColorScheme;
  current: boolean;
  onApply: (name: string) => void;
};

/** 列表里的一张方案卡：名称 + 16 色点 + ls 预览，点击即应用。 */
function SchemeCard({
  scheme,
  current,
  onApply
}: SchemeCardProps) {
  const t = useT();
  return (
    <button
      type="button"
      className={
        current
          ? "scheme-card is-current"
          : "scheme-card"
      }
      onClick={() => onApply(scheme.name)}
    >
      <span className="scheme-card-head">
        <strong>{scheme.name}</strong>
        {current && (
          <span className="scheme-card-check">
            ✓ {t("settings.colorScheme.current")}
          </span>
        )}
      </span>
      <span
        className="scheme-dots"
        aria-hidden="true"
      >
        {scheme.ansi.map((color, index) => (
          <i
            key={index}
            style={{ background: color }}
          />
        ))}
      </span>
      <SchemePreview scheme={scheme} rows={3} />
    </button>
  );
}

type Props = {
  value: string;
  onChange: (name: string) => void;
};

/**
 * 设置页的配色方案选择区：当前方案大预览 + 搜索框 + 方案卡片列表。
 * 点卡片即时生效（与字体/字号一致的离散动作），由设置层落盘。
 *
 * 464 个卡片一次挂载会卡住设置页：初始只渲染一批，列表滚到接近底部
 * 就再追加一批，滚到底自然看完全部。
 */
export default function ColorSchemePicker({
  value,
  onChange
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [darkOnly, setDarkOnly] = useState(true);
  const [visibleCount, setVisibleCount] =
    useState(MAX_VISIBLE);
  const current = useMemo(
    () => resolveColorScheme(value),
    [value]
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return COLOR_SCHEMES.filter(
      scheme =>
        scheme.dark === darkOnly &&
        (!needle ||
          scheme.name
            .toLowerCase()
            .includes(needle))
    );
  }, [query, darkOnly]);
  // 搜索词变化后从第一批重新展示
  const shown = filtered.slice(0, visibleCount);
  const hasMore = shown.length < filtered.length;

  /** 切换夜间/亮色 tab：列表重置回第一批 */
  function switchGroup(dark: boolean) {
    setDarkOnly(dark);
    setVisibleCount(MAX_VISIBLE);
  }

  /** 滚到接近底部就追加下一批；一次 80 张，几滚之内见完全部 */
  function onListScroll(
    event: UIEvent<HTMLDivElement>
  ) {
    if (!hasMore) return;
    const el = event.currentTarget;
    if (
      el.scrollTop + el.clientHeight >=
      el.scrollHeight - 300
    )
      setVisibleCount(count => count + 80);
  }

  return (
    <div className="scheme-picker">
      <SchemePreview scheme={current} />
      <div className="scheme-tabs">
        <button
          type="button"
          className={
            darkOnly
              ? "scheme-tab is-active"
              : "scheme-tab"
          }
          onClick={() => switchGroup(true)}
        >
          {t("settings.colorScheme.dark")}
        </button>
        <button
          type="button"
          className={
            darkOnly
              ? "scheme-tab"
              : "scheme-tab is-active"
          }
          onClick={() => switchGroup(false)}
        >
          {t("settings.colorScheme.light")}
        </button>
      </div>
      <div className="scheme-search">
        <SearchOutlined />
        <Input
          aria-label={t(
            "settings.colorScheme.search"
          )}
          placeholder={t(
            "settings.colorScheme.search"
          )}
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setVisibleCount(MAX_VISIBLE);
          }}
        />
      </div>
      <div
        className="scheme-list"
        onScroll={onListScroll}
      >
        {shown.map(scheme => (
          <SchemeCard
            key={scheme.name}
            scheme={scheme}
            current={scheme.name === current.name}
            onApply={onChange}
          />
        ))}
        {filtered.length === 0 && (
          <p className="scheme-more">
            {t("sidebar.noMatch")}
          </p>
        )}
      </div>
    </div>
  );
}
