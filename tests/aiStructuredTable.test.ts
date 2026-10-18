import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/settings/lib/i18n", () => ({
  useT: () => (key: string) => key
}));

import {
  MAX_TABLE_ROWS,
  filterRows,
  formatCell,
  parseStructuredTable,
  sortRows,
  type StructuredTableSpec
} from "@/terminal/lib/ai/structuredTable";

const sample = {
  title: "占用最高的进程",
  columns: [
    { key: "pid", label: "PID", type: "number" },
    {
      key: "cpu",
      label: "CPU",
      type: "number",
      unit: "%"
    },
    { key: "cmd", label: "命令" }
  ],
  rows: [
    { pid: 3, cpu: 12.5, cmd: "nginx" },
    { pid: 1, cpu: 42.5, cmd: "java" },
    { pid: 2, cpu: null, cmd: "sshd" }
  ]
};

describe("表格数据解析", () => {
  it("完整数据：列与行都保留", () => {
    const spec = parseStructuredTable(
      JSON.stringify(sample)
    );
    expect(spec?.title).toBe("占用最高的进程");
    expect(spec?.columns).toHaveLength(3);
    expect(spec?.rows).toHaveLength(3);
    expect(spec?.columns[1]).toEqual({
      key: "cpu",
      label: "CPU",
      type: "number",
      unit: "%"
    });
  });

  it("坏 JSON / 缺列 / 缺行 → null（回落代码块）", () => {
    expect(
      parseStructuredTable("{ 还没写完")
    ).toBeNull();
    expect(
      parseStructuredTable(
        JSON.stringify({ rows: [{ a: 1 }] })
      )
    ).toBeNull();
    expect(
      parseStructuredTable(
        JSON.stringify({
          columns: [{ key: "a" }]
        })
      )
    ).toBeNull();
    expect(
      parseStructuredTable(
        JSON.stringify({ columns: [], rows: [] })
      )
    ).toBeNull();
  });

  it("列没有 key 的被丢弃；label 缺失用 key 顶上", () => {
    const spec = parseStructuredTable(
      JSON.stringify({
        columns: [
          { key: "a" },
          { key: "", label: "空" }
        ],
        rows: [{ a: 1 }]
      })
    );
    expect(spec?.columns).toHaveLength(1);
    expect(spec?.columns[0]?.label).toBe("a");
  });

  it("只保留声明过的列，多余字段忽略", () => {
    const spec = parseStructuredTable(
      JSON.stringify({
        columns: [{ key: "a" }],
        rows: [{ a: 1, secret: "不该出现" }]
      })
    );
    expect(spec?.rows[0]).toEqual({ a: 1 });
  });

  it("值类型归一：数字保留、布尔转字符串、对象变 null", () => {
    const spec = parseStructuredTable(
      JSON.stringify({
        columns: [
          { key: "a" },
          { key: "b" },
          { key: "c" }
        ],
        rows: [
          { a: 1, b: true, c: { x: 1 } },
          { a: "x", b: null, c: [1] }
        ]
      })
    );
    expect(spec?.rows[0]).toEqual({
      a: 1,
      b: "true",
      c: null
    });
    expect(spec?.rows[1]).toEqual({
      a: "x",
      b: null,
      c: null
    });
  });

  it("行数超上限按上限截断", () => {
    const rows = Array.from(
      { length: MAX_TABLE_ROWS + 20 },
      (_item, index) => ({ a: index })
    );
    const spec = parseStructuredTable(
      JSON.stringify({
        columns: [{ key: "a" }],
        rows
      })
    );
    expect(spec?.rows).toHaveLength(
      MAX_TABLE_ROWS
    );
  });
});

describe("单元格格式化", () => {
  it("空值占位、整数不带小数、小数两位", () => {
    const column = { key: "v", label: "V" };
    expect(formatCell(null, column)).toBe("—");
    expect(formatCell("", column)).toBe("—");
    expect(formatCell(12, column)).toBe("12");
    expect(formatCell(12.345, column)).toBe(
      "12.35"
    );
  });

  it("单位拼在数字后", () => {
    expect(
      formatCell(42.5, {
        key: "cpu",
        label: "CPU",
        unit: "%"
      })
    ).toBe("42.50%");
  });
});

describe("排序", () => {
  const spec = parseStructuredTable(
    JSON.stringify(sample)
  ) as StructuredTableSpec;
  const cpuColumn = spec.columns[1]!;

  it("数字列按数值排，升降序都对；空值沉底", () => {
    const asc = sortRows(
      spec.rows,
      cpuColumn,
      "asc"
    ).map(row => row.cpu);
    expect(asc).toEqual([12.5, 42.5, null]);
    const desc = sortRows(
      spec.rows,
      cpuColumn,
      "desc"
    ).map(row => row.cpu);
    expect(desc).toEqual([42.5, 12.5, null]);
  });

  it("字符串列自然序（认得 v1.10 > v1.9）", () => {
    const rows = [
      { name: "v1.10" },
      { name: "v1.9" }
    ];
    const sorted = sortRows(
      rows,
      { key: "name", label: "版本" },
      "asc"
    );
    expect(sorted.map(row => row.name)).toEqual([
      "v1.9",
      "v1.10"
    ]);
  });

  it("不改动原数组", () => {
    const before = spec.rows.map(row => row.pid);
    sortRows(spec.rows, cpuColumn, "desc");
    expect(spec.rows.map(row => row.pid)).toEqual(
      before
    );
  });
});

describe("筛选", () => {
  const spec = parseStructuredTable(
    JSON.stringify(sample)
  ) as StructuredTableSpec;

  it("全单元格包含匹配，大小写不敏感", () => {
    expect(
      filterRows(spec.rows, spec.columns, "NGINX")
    ).toHaveLength(1);
    expect(
      filterRows(spec.rows, spec.columns, "java")
    ).toHaveLength(1);
  });

  it("数字也能搜（按显示文本）", () => {
    expect(
      filterRows(spec.rows, spec.columns, "42.5")
    ).toHaveLength(1);
  });

  it("空查询返回全部，无匹配返回空", () => {
    expect(
      filterRows(spec.rows, spec.columns, "   ")
    ).toHaveLength(3);
    expect(
      filterRows(spec.rows, spec.columns, "zzz")
    ).toHaveLength(0);
  });
});

describe("渲染与接线", () => {
  it("表格组件渲染出表头与数据行", async () => {
    const { AiStructuredTable } =
      await import("@/terminal/components/ai/AiStructuredTable");
    const spec = parseStructuredTable(
      JSON.stringify(sample)
    ) as StructuredTableSpec;
    const html = renderToStaticMarkup(
      createElement(AiStructuredTable, { spec })
    );
    expect(html).toContain("<table");
    expect(html).toContain("占用最高的进程");
    expect(html).toContain("nginx");
    expect(html).toContain("42.50%");
    // 可排序（表头是按钮）
    expect(html).toContain("<button");
  }, 60_000);

  it("markdown 层拦截 data-table，失败回落代码块", async () => {
    const src = (
      await import("@/terminal/components/ai/AiMarkdown.tsx?raw")
    ).default;
    expect(src).toContain("data-table");
    expect(src).toContain("parseStructuredTable");
    expect(src).toContain("AiStructuredTable");
    expect(src).toContain("AiCodeBlock");
  });

  it("提示词要求命令输出用 data-table", async () => {
    const { SYSTEM_PROMPT } =
      await import("@/terminal/lib/ai/promptContext");
    expect(SYSTEM_PROMPT).toContain("data-table");
    expect(SYSTEM_PROMPT).toContain(
      '"type":"number"'
    );
  });
});
