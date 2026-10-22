/**
 * OSC 7（当前工作目录）解析。
 *
 * 目录栏的「实时跟随」完全依赖这条序列，解析错的表现是「目录栏停在
 * 别的地方」或者「路径里带 %20」，很难从界面反推到这一层，所以钉住。
 */

import { describe, expect, it } from "vitest";
import {
  parseOsc7,
  parsePromptCwd
} from "@/terminal/lib/shellIntegration/osc7";

describe("parseOsc7", () => {
  it("标准形态 file://host/path", () => {
    expect(
      parseOsc7("file://cloud-ti1s74/home/root")
    ).toBe("/home/root");
  });

  it("host 为空（file:///path）", () => {
    expect(parseOsc7("file:///home/root")).toBe(
      "/home/root"
    );
  });

  it("省略 file:// 的裸路径也认", () => {
    expect(parseOsc7("/var/log")).toBe(
      "/var/log"
    );
  });

  it("Windows 盘符：去掉多余的前导斜杠", () => {
    // PowerShell 惯例 file://HOST/C:/Users/x
    expect(
      parseOsc7("file://HOST/C:/Users/x")
    ).toBe("C:/Users/x");
  });

  it("Windows 反斜杠路径统一成正斜杠", () => {
    expect(parseOsc7("C:\\Users\\x")).toBe(
      "C:/Users/x"
    );
  });

  it("百分号编码会解码（路径里常有空格）", () => {
    expect(
      parseOsc7("file://h/srv/my%20app")
    ).toBe("/srv/my app");
  });

  it("畸形编码不抛错，按原样返回", () => {
    expect(parseOsc7("file://h/a%ZZb")).toBe(
      "/a%ZZb"
    );
  });

  it("认不出来返回 null", () => {
    expect(parseOsc7("")).toBeNull();
    expect(parseOsc7("   ")).toBeNull();
    expect(
      parseOsc7("http://example.com")
    ).toBeNull();
    expect(parseOsc7("relative/path")).toBeNull();
  });
});

describe("parsePromptCwd（没有 OSC 7 时的兜底）", () => {
  it("bash 默认 PS1（\\u@\\h:\\w）", () => {
    expect(
      parsePromptCwd(
        "root@cloud-ti1s74:/var/log#"
      )
    ).toBe("/var/log");
  });

  it("家目录简写", () => {
    expect(parsePromptCwd("root@host:~#")).toBe(
      "~"
    );
    expect(
      parsePromptCwd("root@host:~/proj#")
    ).toBe("~/proj");
  });

  it("方括号提示符", () => {
    expect(parsePromptCwd("[user@host ~]$")).toBe(
      "~"
    );
    expect(
      parsePromptCwd("[user@host /srv/app]$")
    ).toBe("/srv/app");
  });

  it("# 前带空格的写法", () => {
    expect(
      parsePromptCwd("root@host:/var/log #")
    ).toBe("/var/log");
  });

  it("PowerShell 盘符路径（冒号不能把路径拆碎）", () => {
    expect(
      parsePromptCwd("PS C:\\Users\\x>")
    ).toBe("C:/Users/x");
  });

  it("不含路径的提示符不瞎猜", () => {
    // oh-my-zsh 那类只有目录名、没有完整路径的提示符
    expect(
      parsePromptCwd("➜  tera-shell git:(main)")
    ).toBeNull();
    expect(parsePromptCwd("$ ")).toBeNull();
    // 时间里的冒号不能被当成路径
    expect(
      parsePromptCwd("[12:34:56] $")
    ).toBeNull();
  });
});
