import { describe, expect, it } from "vitest";
import {
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelay,
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_DELAY,
  shouldAutoReconnect,
  SSH_ERROR_EXIT_CODE
} from "@/terminal/lib/reconnect";

/**
 * 自动重连的判定与退避。
 *
 * 这两条逻辑决定了「会不会把用户敲 exit 的会话强行拉起来」和
 * 「重连会不会退化成高频重试」，是自动重连里最容易出错的部分。
 */
describe("自动重连策略", () => {
  it("只对 ssh 的连接错误码（255）重连", () => {
    expect(
      shouldAutoReconnect(
        "ssh",
        SSH_ERROR_EXIT_CODE
      )
    ).toBe(true);
  });

  it("用户自己退出不重连：本地会话、ssh 正常退出（0）", () => {
    expect(shouldAutoReconnect("local", 0)).toBe(
      false
    );
    expect(shouldAutoReconnect("ssh", 0)).toBe(
      false
    );
    expect(shouldAutoReconnect("ssh", 1)).toBe(
      false
    );
    expect(
      shouldAutoReconnect("local", 255)
    ).toBe(false);
  });

  it("退出码缺失时保守处理，不自动重连", () => {
    expect(shouldAutoReconnect("ssh", null)).toBe(
      false
    );
    expect(
      shouldAutoReconnect("ssh", undefined)
    ).toBe(false);
  });

  it("退避按 2 的幂增长并封顶", () => {
    expect(reconnectDelay(1)).toBe(
      RECONNECT_BASE_DELAY
    );
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(3)).toBe(4000);
    expect(reconnectDelay(4)).toBe(8000);
    // 第 5 次理论值 16s，被上限压到 15s
    expect(reconnectDelay(5)).toBe(
      RECONNECT_MAX_DELAY
    );
    expect(reconnectDelay(9)).toBe(
      RECONNECT_MAX_DELAY
    );
  });

  it("非法次数按第一次处理，不抛出", () => {
    expect(reconnectDelay(0)).toBe(
      RECONNECT_BASE_DELAY
    );
    expect(reconnectDelay(-3)).toBe(
      RECONNECT_BASE_DELAY
    );
  });

  it("总重试次数有限，累计等待不超过 30 秒", () => {
    let total = 0;
    for (
      let attempt = 1;
      attempt <= MAX_RECONNECT_ATTEMPTS;
      attempt++
    ) {
      total += reconnectDelay(attempt);
    }
    expect(total).toBe(30000);
  });
});
