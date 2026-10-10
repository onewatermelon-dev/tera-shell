// SFTP 传输面板的进度事件合并。
//
// 为什么单独测：暂停后迟到的进度事件会把状态冲回"传输中"，按钮弹回
// "暂停"，用户看起来要点两次才真的停（真机上事件到达顺序无法复现
// 稳定，这里直接对合并逻辑断言）。
import { describe, expect, it } from "vitest";
import {
  activeElapsedMs,
  applyTransferEvent,
  type TransferTask
} from "@/sftp/lib/sftpUtils";

function task(
  patch: Partial<TransferTask> = {}
): TransferTask {
  return {
    id: "t-1",
    name: "big.bin",
    direction: "upload",
    status: "running",
    bytes: 512,
    total: 4096,
    startedAt: 0,
    ...patch
  };
}

const progress = {
  id: "t-1",
  bytes: 1024,
  total: 4096,
  done: false
};

describe("applyTransferEvent", () => {
  it("运行中的任务：进度事件刷新字节并保持传输中", () => {
    const merged = applyTransferEvent(
      task(),
      progress
    );
    expect(merged.status).toBe("running");
    expect(merged.bytes).toBe(1024);
    expect(merged.endedAt).toBeUndefined();
  });

  it("已暂停的任务：迟到的进度事件不能冲回传输中", () => {
    const merged = applyTransferEvent(
      task({ status: "paused" }),
      progress
    );
    expect(merged.status).toBe("paused");
    // 字节仍随事件更新，数值本身无害
    expect(merged.bytes).toBe(1024);
  });

  it("done 事件：暂停状态也要被标成完成", () => {
    const merged = applyTransferEvent(
      task({ status: "paused" }),
      { ...progress, done: true }
    );
    expect(merged.status).toBe("done");
    expect(merged.endedAt).toBeTypeOf("number");
  });

  it("事件里的总量非 0 时覆盖列表里的旧值", () => {
    const merged = applyTransferEvent(
      task({ total: 0 }),
      progress
    );
    expect(merged.total).toBe(4096);
  });

  it("已取消的任务：迟到的进度事件不能复活成传输中", () => {
    const merged = applyTransferEvent(
      task({
        status: "cancelled",
        endedAt: 1000
      }),
      progress
    );
    expect(merged.status).toBe("cancelled");
    expect(merged.endedAt).toBe(1000);
  });

  it("已失败/已完成：同样不被迟到事件复活", () => {
    expect(
      applyTransferEvent(
        task({ status: "failed" }),
        progress
      ).status
    ).toBe("failed");
    expect(
      applyTransferEvent(
        task({ status: "done" }),
        progress
      ).status
    ).toBe("done");
  });

  it("已取消的任务收到迟到的 done 事件：状态与结束时间都不被改写", () => {
    const merged = applyTransferEvent(
      task({
        status: "cancelled",
        endedAt: 1000
      }),
      { ...progress, done: true }
    );
    expect(merged.status).toBe("cancelled");
    expect(merged.endedAt).toBe(1000);
  });
});

describe("activeElapsedMs", () => {
  it("运行中：随 now 增长", () => {
    expect(
      activeElapsedMs(
        task({ startedAt: 0, bytes: 100 }),
        5000
      )
    ).toBe(5000);
  });

  it("暂停中：定格在暂停时刻，now 继续跳也不增长", () => {
    const paused = task({
      startedAt: 0,
      pausedAt: 4000
    });
    expect(activeElapsedMs(paused, 5000)).toBe(
      4000
    );
    expect(activeElapsedMs(paused, 9000)).toBe(
      4000
    );
  });

  it("恢复后：从活跃时长继续累计，扣除暂停期间", () => {
    // 传输 4s + 暂停 5s + 恢复后再传 3s → 活跃 7s
    const resumed = task({
      startedAt: 0,
      pausedMs: 5000
    });
    expect(activeElapsedMs(resumed, 12000)).toBe(
      7000
    );
  });

  it("结束后：用 endedAt 收口，不再受 now 影响", () => {
    const ended = task({
      startedAt: 0,
      endedAt: 8000,
      pausedMs: 2000
    });
    expect(activeElapsedMs(ended, 99999)).toBe(
      6000
    );
  });
});
