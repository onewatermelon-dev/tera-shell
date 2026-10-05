import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  commandInDirectory,
  directoryFromPrompt
} from "@/terminal/lib/aiChat";

/** 构造只含当前提示符行的终端缓冲区。 */
function terminalAt(prompt: string): Terminal {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine: () => ({
          translateToString: () => prompt
        })
      }
    }
  } as unknown as Terminal;
}

describe("AI 后台命令目录", () => {
  it("使用终端当前目录并安全引用路径", () => {
    const directory = directoryFromPrompt(
      terminalAt("root@server:/srv/my'app# ")
    );
    expect(directory).toBe("/srv/my'app");
    expect(
      commandInDirectory(directory!, "pwd")
    ).toBe(
      "cd -- '/srv/my'\\''app' || exit 1\npwd"
    );
  });

  it("无法识别当前提示符时不猜测目录", () => {
    expect(
      directoryFromPrompt(terminalAt("vim"))
    ).toBeNull();
  });
});
