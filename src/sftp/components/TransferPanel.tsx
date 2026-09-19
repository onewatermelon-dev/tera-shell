import { useEffect, useState } from "react";
import type {
  TransferControlAction,
  TransferDirection,
  TransferStatus,
  TransferTask
} from "@/sftp/lib/useSftp";

const STATUS_TEXT: Record<
  TransferStatus,
  string
> = {
  running: "传输中",
  paused: "已暂停",
  done: "完成",
  failed: "失败",
  cancelled: "已取消"
};

/** 名称列前的方向标记。 */
const DIRECTION_ARROW: Record<
  TransferDirection,
  string
> = {
  upload: "↑",
  download: "↓",
  delete: "✕"
};

/** 方向列的文案。 */
const DIRECTION_TEXT: Record<
  TransferDirection,
  string
> = {
  upload: "本地 → 远程",
  download: "远程 → 本地",
  delete: "远程删除"
};

/** 状态文案：删除任务运行中显示"删除中"而不是"传输中"。 */
function statusText(task: TransferTask): string {
  if (
    task.direction === "delete" &&
    task.status === "running"
  ) {
    return "删除中";
  }
  return STATUS_TEXT[task.status];
}

/** 时钟格式：HH:MM:SS。 */
function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}

/** 时长格式：12s / 1m20s / 1h02m。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(
    minutes % 60
  ).padStart(2, "0")}m`;
}

/** 字节数格式：1.2 MB（B 级别取整，避免出现一长串小数）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (
    value >= 1024 &&
    index < units.length - 1
  ) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/**
 * 速度格式：1.23 MB/s。
 *
 * 不复用 formatBytes：速度是实时算出来的，小数位容易拖得很长，
 * 这里统一保留**两位**小数。
 */
function formatSpeed(
  bytesPerSecond: number
): string {
  if (
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return "—";
  }
  if (bytesPerSecond < 1024) {
    return `${bytesPerSecond.toFixed(2)} B/s`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytesPerSecond / 1024;
  let index = 0;
  while (
    value >= 1024 &&
    index < units.length - 1
  ) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(2)} ${units[index]}/s`;
}

/** 单行传输信息。 */
function TransferRow({
  task,
  now,
  onControl
}: {
  task: TransferTask;
  now: number;
  onControl: (
    id: string,
    action: TransferControlAction
  ) => void;
}) {
  // 速度按平均速度算：进度事件只给字节数与时间戳，够用且不用额外维护状态
  const elapsedMs =
    (task.endedAt ?? now) - task.startedAt;
  const speed =
    elapsedMs > 0
      ? (task.bytes / elapsedMs) * 1000
      : 0;
  const percent =
    task.total > 0
      ? Math.min(
          100,
          (task.bytes / task.total) * 100
        )
      : 0;
  const remainingMs =
    task.status === "running" &&
    speed > 0 &&
    task.total > task.bytes
      ? ((task.total - task.bytes) / speed) * 1000
      : null;

  return (
    <div className="transfer-grid transfer-row">
      <span
        className="transfer-name"
        title={task.error ?? task.name}
      >
        <em className="transfer-arrow">
          {DIRECTION_ARROW[task.direction]}
        </em>
        {task.name}
      </span>
      <span
        className={`transfer-status is-${task.status}`}
      >
        {statusText(task)}
      </span>
      <span className="transfer-progress">
        <span className="transfer-bar">
          <i style={{ width: `${percent}%` }} />
        </span>
        <em>
          {task.total > 0
            ? `${percent.toFixed(0)}%`
            : "—"}
        </em>
      </span>
      <span className="transfer-size">
        {task.total > 0
          ? formatBytes(task.total)
          : "—"}
      </span>
      <span className="transfer-direction">
        {DIRECTION_TEXT[task.direction]}
      </span>
      <span>{formatClock(task.startedAt)}</span>
      <span>
        {task.endedAt
          ? formatClock(task.endedAt)
          : "—"}
      </span>
      <span>{formatSpeed(speed)}</span>
      <span>{formatDuration(elapsedMs)}</span>
      <span>
        {remainingMs === null
          ? "—"
          : formatDuration(remainingMs)}
      </span>
      {/* 进行中的任务可以暂停 / 恢复 / 取消；结束后按钮消失 */}
      <span className="transfer-actions">
        {task.status === "running" && (
          <button
            type="button"
            className="transfer-action"
            onClick={() =>
              onControl(task.id, "pause")
            }
          >
            暂停
          </button>
        )}
        {task.status === "paused" && (
          <button
            type="button"
            className="transfer-action"
            onClick={() =>
              onControl(task.id, "resume")
            }
          >
            恢复
          </button>
        )}
        {(task.status === "running" ||
          task.status === "paused") && (
          <button
            type="button"
            className="transfer-action transfer-action--danger"
            onClick={() =>
              onControl(task.id, "cancel")
            }
          >
            取消
          </button>
        )}
      </span>
    </div>
  );
}

type TransferPanelProps = {
  tasks: TransferTask[];
  /** 清掉已结束的任务，正在传输的保留 */
  onClear: () => void;
  /** 暂停 / 恢复 / 取消某个任务 */
  onControl: (
    id: string,
    action: TransferControlAction
  ) => void;
};

/**
 * 窗口底部的传输信息面板：逐行展示每个任务的状态、进度与时间。
 *
 * 进度来自后端事件，但"经过 / 剩余时间"依赖当前时间，
 * 所以这里每秒更新一次 now（interval 回调里 setState 属于异步更新，
 * 且不在渲染期调用 `Date.now()`，符合 hooks 的纯度要求）。
 */
export default function TransferPanel({
  tasks,
  onClear,
  onControl
}: TransferPanelProps) {
  // 当前时间：首帧为 0，时间列先显示"—"，1 秒内即对齐
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      1000
    );
    return () => window.clearInterval(timer);
  }, []);

  const finished = tasks.some(
    task => task.status !== "running"
  );

  return (
    <section className="sftp-transfers">
      <div className="transfer-head">
        <span className="transfer-title">
          传输
          {tasks.length > 0 && (
            <em className="transfer-count">
              {tasks.length}
            </em>
          )}
        </span>
        <button
          type="button"
          className="transfer-clear"
          disabled={!finished}
          onClick={onClear}
        >
          清空已完成
        </button>
      </div>
      <div className="transfer-scroll">
        <div className="transfer-grid transfer-head-row">
          <span>名称</span>
          <span>状态</span>
          <span>进度</span>
          <span>文件大小</span>
          <span>方向</span>
          <span>开始时间</span>
          <span>结束时间</span>
          <span>速度</span>
          <span>经过时间</span>
          <span>剩余时间</span>
          <span>操作</span>
        </div>
        {tasks.length ? (
          tasks.map(task => (
            <TransferRow
              key={task.id}
              task={task}
              now={now}
              onControl={onControl}
            />
          ))
        ) : (
          <p className="transfer-empty">
            暂无传输任务
          </p>
        )}
      </div>
    </section>
  );
}
