/**
 * 提权凭据的生命周期：**绑定会话，换对话即失效**。
 *
 * 这是安全边界，不是便利性取舍：上一台机器的 root 密码不能继续用于下一台。
 */

import {
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import {
  clearEscalation,
  getEscalationPasswords,
  hasEscalationPassword,
  setEscalationPasswords
} from "@/terminal/lib/ai/escalation";

beforeEach(() => {
  clearEscalation();
});

describe("提权凭据", () => {
  it("配了之后本会话读得到", () => {
    setEscalationPasswords("s1", {
      sudoPassword: "sudo-pw",
      suPassword: "root-pw"
    });
    expect(getEscalationPasswords("s1")).toEqual({
      sudoPassword: "sudo-pw",
      suPassword: "root-pw"
    });
    expect(hasEscalationPassword("s1")).toBe(
      true
    );
  });

  it("换会话读不到（哪怕没显式清过）", () => {
    setEscalationPasswords("s1", {
      sudoPassword: "",
      suPassword: "root-pw"
    });
    // 直接查 s2：凭据按会话绑定，自动失效
    expect(getEscalationPasswords("s2")).toEqual({
      sudoPassword: "",
      suPassword: ""
    });
    expect(hasEscalationPassword("s2")).toBe(
      false
    );
  });

  it("两端空格被裁掉（粘贴常带换行）", () => {
    setEscalationPasswords("s1", {
      sudoPassword: "  pw \n",
      suPassword: "\troot\n"
    });
    expect(getEscalationPasswords("s1")).toEqual({
      sudoPassword: "pw",
      suPassword: "root"
    });
  });

  it("只配一个也算启用", () => {
    setEscalationPasswords("s1", {
      sudoPassword: "",
      suPassword: "root-pw"
    });
    expect(hasEscalationPassword("s1")).toBe(
      true
    );
  });

  it("清空后本会话也读不到", () => {
    setEscalationPasswords("s1", {
      sudoPassword: "a",
      suPassword: "b"
    });
    clearEscalation();
    expect(hasEscalationPassword("s1")).toBe(
      false
    );
  });

  it("两个都空 = 未启用", () => {
    setEscalationPasswords("s1", {
      sudoPassword: "   ",
      suPassword: ""
    });
    expect(hasEscalationPassword("s1")).toBe(
      false
    );
  });
});
