// 拖路径进终端：条目 → 终端输入行文本的转换。
//
// 为什么单独测：引号转义错了（路径带单引号/空格）会把命令注入
// shell，或者粘贴出来就不是用户拖的那个路径。
import { describe, expect, it } from "vitest";
import {
  pathsToTerminalText,
  type PaneEntry
} from "@/sftp/lib/sftpUtils";

function entry(
  path: string,
  isDir = false
): PaneEntry {
  return { name: "n", path, isDir, size: 0 };
}

describe("pathsToTerminalText", () => {
  it("单个目录 → cd + 单引号路径", () => {
    expect(
      pathsToTerminalText([
        entry("/var/log", true)
      ])
    ).toBe("cd '/var/log'");
  });

  it("单个文件 → 单引号路径（好接在命令后面）", () => {
    expect(
      pathsToTerminalText([
        entry("/etc/nginx.conf")
      ])
    ).toBe("'/etc/nginx.conf'");
  });

  it("路径里的单引号按 POSIX 规则转义", () => {
    expect(
      pathsToTerminalText([
        entry("/tmp/it's here.txt")
      ])
    ).toBe("'/tmp/it'\\''s here.txt'");
  });

  it("多个条目 → 空格连接的引号路径（不自动拼 cd）", () => {
    expect(
      pathsToTerminalText([
        entry("/var/log", true),
        entry("/etc/nginx.conf")
      ])
    ).toBe("'/var/log' '/etc/nginx.conf'");
  });

  it("Windows 本地路径保持反斜杠原样", () => {
    expect(
      pathsToTerminalText([
        entry("D:\\工作 目录", true)
      ])
    ).toBe("cd 'D:\\工作 目录'");
  });
});
