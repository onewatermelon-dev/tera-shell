"use client";

/**
 * 结构化表格卡片：渲染 ```data-table 围栏块。
 *
 * 交互只有两件事：**点表头排序**、**输入框筛选**。刻意不做分页 /
 * 列宽拖拽 —— 这是回答里的辅助视图，不是数据工作台。
 *
 * 排序状态用 `key + direction` 而不是存整列对象：列是从 spec 现算的，
 * 存对象会在 spec 变化后指向旧引用。
 */

import { useMemo, useState } from "react";
import { useT } from "@/settings/lib/i18n";
import {
  MAX_TABLE_ROWS,
  filterRows,
  formatCell,
  isTruncated,
  sortRows,
  type StructuredTableSpec
} from "@/terminal/lib/ai/structuredTable";
import styles from "./AiStructuredTable.module.css";

export function AiStructuredTable({
  spec
}: {
  spec: StructuredTableSpec;
}) {
  const t = useT();
  const [sortKey, setSortKey] = useState<
    string | null
  >(null);
  const [direction, setDirection] = useState<
    "asc" | "desc"
  >("asc");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const filtered = filterRows(
      spec.rows,
      spec.columns,
      query
    );
    const column = spec.columns.find(
      item => item.key === sortKey
    );
    if (!column) return filtered;
    return sortRows(filtered, column, direction);
  }, [spec, sortKey, direction, query]);

  /** 点同一列表头切方向，换列则重置为升序。 */
  function toggleSort(key: string) {
    if (key === sortKey) {
      setDirection(current =>
        current === "asc" ? "desc" : "asc"
      );
      return;
    }
    setSortKey(key);
    setDirection("asc");
  }

  const shown = rows.slice(0, MAX_TABLE_ROWS);

  return (
    <figure className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>
          {spec.title || t("ai.table.title")}
        </span>
        <input
          className={styles.filter}
          value={query}
          placeholder={t("ai.table.filter")}
          aria-label={t("ai.table.filter")}
          onChange={event =>
            setQuery(event.target.value)
          }
        />
      </div>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {spec.columns.map(column => (
                <th
                  key={column.key}
                  className={
                    column.type === "number"
                      ? styles.headNum
                      : undefined
                  }
                  aria-sort={
                    sortKey === column.key
                      ? direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    className={styles.sortButton}
                    onClick={() =>
                      toggleSort(column.key)
                    }
                  >
                    {column.label}
                    {sortKey === column.key && (
                      <span
                        className={
                          styles.sortMark
                        }
                        aria-hidden="true"
                      >
                        {direction === "asc"
                          ? "▲"
                          : "▼"}
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {spec.columns.map(column => (
                  <td
                    key={column.key}
                    className={
                      column.type === "number"
                        ? styles.cellNum
                        : undefined
                    }
                  >
                    {formatCell(
                      row[column.key] ?? null,
                      column
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className={styles.empty}>
            {t("ai.table.empty")}
          </p>
        )}
      </div>
      <div className={styles.foot}>
        <span>
          {t("ai.table.rows")} {shown.length}
          {isTruncated(
            spec.rows.length,
            shown.length
          )
            ? ` / ${spec.rows.length}`
            : ""}
        </span>
      </div>
    </figure>
  );
}
