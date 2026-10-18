/**
 * 查找浮层：输入框 + 命中计数 + 上/下一个 + 大小写/正则开关 + 关闭。
 *
 * 从 TerminalWorkspace.tsx 拆出（2026-10-13）。查询词由父级持有
 * （关掉再开要保留上一次的关键词），本组件只负责渲染与交互；
 * 打开时自动聚焦全选。HeroUI Surface：查找浮层的底色/描边/阴影
 * 跟随主题 token。
 */
import { useEffect, useRef } from "react";
import {
  Button,
  Input,
  Surface,
  ToggleButton
} from "@heroui/react";
import Hint from "@/shared/components/Hint";
import { useT } from "@/settings/lib/i18n";

export function FindBox({
  query,
  onQueryChange,
  result,
  error,
  caseSensitive,
  regex,
  onSearch,
  onCloseSearch,
  onToggleCaseSensitive,
  onToggleRegex
}: {
  query: string;
  onQueryChange: (query: string) => void;
  result: { index: number; count: number };
  error: string;
  caseSensitive: boolean;
  regex: boolean;
  onSearch: (
    query: string,
    direction: "next" | "prev" | "input"
  ) => void;
  onCloseSearch: () => void;
  onToggleCaseSensitive: () => void;
  onToggleRegex: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时自动聚焦全选
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  function toggleAndSearch(toggle: () => void) {
    toggle();
    onSearch(query, "input");
  }

  const searchCount = result.count;
  const searchIndex = result.index;

  return (
    <Surface className="find-box">
      <Input
        ref={inputRef}
        className="find-input"
        placeholder={t(
          "terminal.find.placeholder"
        )}
        value={query}
        onChange={e => {
          onQueryChange(e.target.value);
          onSearch(e.target.value, "input");
        }}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSearch(query, "next");
          }
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            onSearch(query, "prev");
          }
          if (e.key === "Escape") onCloseSearch();
        }}
      />
      <span className="find-count">
        {error ||
          (searchCount
            ? `${searchIndex + 1}/${searchCount}`
            : query
              ? t("terminal.find.noMatch")
              : "")}
      </span>
      <Hint label={t("terminal.find.prev")}>
        <Button
          className="find-btn"
          variant="tertiary"
          size="sm"
          aria-label={t("terminal.find.prev")}
          onPress={() => onSearch(query, "prev")}
        >
          ↑
        </Button>
      </Hint>
      <Hint label={t("terminal.find.next")}>
        <Button
          className="find-btn"
          variant="tertiary"
          size="sm"
          aria-label={t("terminal.find.next")}
          onPress={() => onSearch(query, "next")}
        >
          ↓
        </Button>
      </Hint>
      <Hint
        label={t("terminal.find.caseSensitive")}
      >
        <ToggleButton
          className="find-btn"
          variant="ghost"
          size="sm"
          aria-label={t(
            "terminal.find.caseSensitive"
          )}
          isSelected={caseSensitive}
          onChange={() =>
            toggleAndSearch(onToggleCaseSensitive)
          }
        >
          Aa
        </ToggleButton>
      </Hint>
      <Hint label={t("terminal.find.regex")}>
        <ToggleButton
          className="find-btn"
          variant="ghost"
          size="sm"
          aria-label={t("terminal.find.regex")}
          isSelected={regex}
          onChange={() =>
            toggleAndSearch(onToggleRegex)
          }
        >
          .*
        </ToggleButton>
      </Hint>
      <Hint label={t("terminal.find.close")}>
        <Button
          className="find-btn"
          variant="tertiary"
          size="sm"
          aria-label={t("terminal.find.close")}
          onPress={onCloseSearch}
        >
          ×
        </Button>
      </Hint>
    </Surface>
  );
}
