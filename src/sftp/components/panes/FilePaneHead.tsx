/**
 * 文件栏的标题行：栏名、磁盘用量、载入/已选提示，以及目录内过滤框。
 *
 * 从 FilePane.tsx 拆出（2026-10-13）。
 */
export function FilePaneHead({
  label,
  usageText,
  busy,
  selectedCount,
  filter,
  onFilterChange
}: {
  label: string;
  /** 标题旁的磁盘用量摘要（仅远程栏有）；null 不显示。 */
  usageText?: string | null;
  busy: boolean;
  /** 多选计数（>1 才显示） */
  selectedCount: number;
  filter: string;
  onFilterChange: (value: string) => void;
}) {
  return (
    <div className="sftp-pane-head">
      <span className="sftp-pane-title">
        {label}
        {usageText && (
          <em
            className="pane-usage"
            title={usageText}
          >
            {usageText}
          </em>
        )}
        {busy && (
          <em className="pane-busy">载入中…</em>
        )}
        {selectedCount > 1 && (
          <em className="pane-busy">
            已选 {selectedCount} 项
          </em>
        )}
      </span>
      {/* 目录内过滤框：输入即筛选，Esc 或 × 清空 */}
      <span className="pane-filter-wrap">
        <input
          className="pane-filter"
          value={filter}
          placeholder="过滤当前目录"
          spellCheck={false}
          onChange={event =>
            onFilterChange(event.target.value)
          }
          onKeyDown={event => {
            if (event.key === "Escape") {
              onFilterChange("");
              event.currentTarget.blur();
            }
          }}
        />
        {filter && (
          <button
            type="button"
            className="pane-filter-clear"
            aria-label="清除过滤"
            onClick={() => onFilterChange("")}
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}
