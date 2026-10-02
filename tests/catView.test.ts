import { describe, expect, it } from "vitest";
import {
  isVimCommand,
  parseCatCommand
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

describe("isVimCommand", () => {
  it("带文件的 vim/vi/view 命中", () => {
    expect(isVimCommand("vim app.py")).toBe(true);
    expect(isVimCommand("vi main.c")).toBe(true);
    expect(
      isVimCommand("view -R /etc/hosts")
    ).toBe(true);
    expect(isVimCommand("  vim app.rs  ")).toBe(
      true
    );
  });

  it("无参数 vim 与非 vim 命令不命中", () => {
    expect(isVimCommand("vim")).toBe(false);
    expect(isVimCommand("ls")).toBe(false);
    expect(isVimCommand("vimdir a")).toBe(false);
  });
});
