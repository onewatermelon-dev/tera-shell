/**
 * 结构化表格：把 `ps aux` / `docker ps` / `ss -tlnp` 这类命令输出
 * 变成**可排序、可筛选**的表格卡，而不是一坨等宽文本。
 *
 * ## 为什么还是围栏块
 *
 * 与 metric-chart 一致：模型只是换一种输出格式，不需要执行任何东西。
 * 用 ```data-table 描述列与行，渲染层拦下来即可：
 *
 * ```data-table
 * { "title": "占用最高的进程",
 *   "columns": [{"key":"pid","label":"PID","type":"number"},
 *               {"key":"cmd","label":"命令"}],
 *   "rows": [{"pid": 1234, "cmd": "nginx"}] }
 * ```
 *
 * 解析 / 排序 / 筛选全部是纯函数：node 环境没有 DOM，靠它们做单测。
 */

/** 一列的声明。 */
export type TableColumn = {
  key: string;
  label: string;
  /** number = 右对齐并按数值排序，默认按字符串（自然序，认得 v1.10 > v1.9） */
  type?: "string" | "number";
  /** 展示后缀，如 % / MB */
  unit?: string;
};

/** 单元格：原始数据可能是数字、字符串或空。 */
export type TableCell = string | number | null;

/** 解析后的表格规格。 */
export type StructuredTableSpec = {
  title: string;
  columns: TableColumn[];
  rows: Record<string, TableCell>[];
};

/**
 * 行数上限：命令输出动辄几百行，全塞进 DOM 会卡。
 *
 * 超出只在**展示层**截断（数据仍完整保留在模型输出里），并提示
 * 「已显示前 N 行」，让用户知道不是数据丢了。
 */
export const MAX_TABLE_ROWS = 200;

const MAX_COLUMNS = 12;

/** 解析 ```data-table 的内容；格式不对返回 null（由渲染层回落代码块）。 */
export function parseStructuredTable(
  raw: string
): StructuredTableSpec | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object")
    return null;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.columns)) return null;
  if (!Array.isArray(obj.rows)) return null;

  const columns: TableColumn[] = [];
  for (const item of obj.columns.slice(
    0,
    MAX_COLUMNS
  )) {
    if (!item || typeof item !== "object")
      continue;
    const column = item as Record<
      string,
      unknown
    >;
    const key = String(column.key ?? "").trim();
    if (!key) continue;
    columns.push({
      key,
      label:
        String(column.label ?? "").trim() || key,
      type:
        column.type === "number"
          ? "number"
          : undefined,
      unit:
        typeof column.unit === "string"
          ? column.unit.slice(0, 8)
          : undefined
    });
  }
  // 没有可用列就没法成表
  if (columns.length === 0) return null;

  const rows: Record<string, TableCell>[] = [];
  for (const item of obj.rows.slice(
    0,
    MAX_TABLE_ROWS
  )) {
    if (!item || typeof item !== "object")
      continue;
    const source = item as Record<
      string,
      unknown
    >;
    const row: Record<string, TableCell> = {};
    for (const column of columns) {
      const value = source[column.key];
      if (typeof value === "number") {
        row[column.key] = Number.isFinite(value)
          ? value
          : null;
      } else if (
        typeof value === "string" ||
        typeof value === "boolean"
      ) {
        row[column.key] = String(value);
      } else {
        row[column.key] = null;
      }
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;

  return {
    title:
      typeof obj.title === "string"
        ? obj.title.slice(0, 80)
        : "",
    columns,
    rows
  };
}

/** 单元格显示文本：空值给占位符，数字不加多余小数。 */
export function formatCell(
  value: TableCell,
  column: TableColumn
): string {
  if (value == null || value === "") return "—";
  const body =
    typeof value === "number"
      ? Number.isInteger(value)
        ? String(value)
        : value.toFixed(2)
      : String(value);
  return column.unit
    ? `${body}${column.unit}`
    : body;
}

/**
 * 按列排序（返回新数组，不改原数据）。
 *
 * 数字列按数值比；字符串列用 `localeCompare(numeric: true)` —— 进程名
 * 排序、版本号（v1.9 < v1.10）都符合直觉。空值统一沉底。
 */
export function sortRows(
  rows: Record<string, TableCell>[],
  column: TableColumn,
  direction: "asc" | "desc"
): Record<string, TableCell>[] {
  const factor = direction === "asc" ? 1 : -1;
  const pick = (
    row: Record<string, TableCell>
  ): TableCell => row[column.key] ?? null;
  return [...rows].sort((left, right) => {
    const a = pick(left);
    const b = pick(right);
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (
      typeof a === "number" &&
      typeof b === "number"
    )
      return (a - b) * factor;
    return (
      String(a).localeCompare(
        String(b),
        "zh-CN",
        {
          numeric: true,
          sensitivity: "base"
        }
      ) * factor
    );
  });
}

/** 全单元格包含匹配（大小写不敏感）；空查询返回原数组。 */
export function filterRows(
  rows: Record<string, TableCell>[],
  columns: TableColumn[],
  query: string
): Record<string, TableCell>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(row =>
    columns.some(column =>
      formatCell(row[column.key] ?? null, {
        ...column,
        unit: undefined
      })
        .toLowerCase()
        .includes(needle)
    )
  );
}

/** 是否有被展示上限截掉的行（UI 要提示）。 */
export function isTruncated(
  total: number,
  shown: number
): boolean {
  return total > shown;
}
