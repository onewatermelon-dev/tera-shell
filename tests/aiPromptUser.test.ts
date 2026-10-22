/**
 * 从提示符里认「终端当前是谁」。
 *
 * 这个判断决定 AI 的命令走终端还是走后台通道 —— 认错了就会以错误身份
 * 执行（`su -` 成 root 后仍用 esnpire 的权限），所以钉住常见提示符形态。
 */

import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { userFromPrompt } from "@/terminal/lib/ai/tools";

/** 造一只只有一行缓冲区的假终端 */
function fakeTerminal(line: string): Terminal {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine: () => ({
          translateToString: () => line
        })
      }
    }
  } as unknown as Terminal;
}

describe("userFromPrompt", () => {
  it("bash 默认提示符取到用户名", () => {
    expect(
      userFromPrompt(
        fakeTerminal("root@cloud-ti1s74:~#")
      )
    ).toBe("root");
    expect(
      userFromPrompt(
        fakeTerminal("enspire@host:/srv/app$")
      )
    ).toBe("enspire");
  });

  it("方括号提示符也能认", () => {
    expect(
      userFromPrompt(
        fakeTerminal("[user@host ~]$")
      )
    ).toBe("user");
  });

  it("没有提示符 / 认不出就返回 null（别乱猜身份）", () => {
    expect(userFromPrompt(undefined)).toBeNull();
    expect(
      userFromPrompt(fakeTerminal(""))
    ).toBeNull();
    expect(
      userFromPrompt(
        fakeTerminal("➜  tera-shell git:(main)")
      )
    ).toBeNull();
    // 命令回显不是提示符
    expect(
      userFromPrompt(fakeTerminal("total 0"))
    ).toBeNull();
  });
});
