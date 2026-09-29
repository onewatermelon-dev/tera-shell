import { describe, expect, it } from "vitest";
import {
  parseCatCommand,
  parseVimCommand
} from "../src/terminal/lib/catView";

describe("parseCatCommand", () => {
  it("拦截单文件 cat", () => {
    expect(parseCatCommand("cat app.py")).toBe(
      "app.py"
    );
    expect(
      parseCatCommand('cat "my file.ts"')
    ).toBe("my file.ts");
    expect(
      parseCatCommand("  cat /etc/hosts  ")
    ).toBe("/etc/hosts");
  });

  it("shell 元字符与多参数放行", () => {
    expect(parseCatCommand("cat a b")).toBeNull();
    expect(
      parseCatCommand("cat a > b")
    ).toBeNull();
    expect(
      parseCatCommand("cat a | grep x")
    ).toBeNull();
    expect(
      parseCatCommand("cat *.py")
    ).toBeNull();
    expect(
      parseCatCommand("cat -n a")
    ).toBeNull();
    expect(parseCatCommand("cat")).toBeNull();
    expect(parseCatCommand("catdir")).toBeNull();
  });
});

describe("parseVimCommand", () => {
  it("改写为带 syntax on 的命令", () => {
    expect(parseVimCommand("vim app.py")).toBe(
      "vim -c 'syntax on' app.py"
    );
    expect(parseVimCommand("vi main.c")).toBe(
      "vi -c 'syntax on' main.c"
    );
    expect(
      parseVimCommand("vim -R /etc/hosts")
    ).toBe("vim -c 'syntax on' -R /etc/hosts");
  });

  it("colorscheme 模式挂上 One Dark Pro", () => {
    expect(
      parseVimCommand("vim app.py", true)
    ).toBe(
      "vim -c 'syntax on' -c 'colorscheme OneDarkPro' app.py"
    );
    expect(
      parseVimCommand("vim", true)
    ).toBeNull();
  });

  it("无参数 vim 不改写", () => {
    expect(parseVimCommand("vim")).toBeNull();
    expect(parseVimCommand("ls")).toBeNull();
  });
});
