/**
 * 粘贴防护的判定测试。
 *
 * 这一层的价值全在「既不漏、也不乱打扰」：漏一次就是不可逆的误操作，
 * 多拦一次用户就会把确认点成肌肉记忆。所以两边都钉住 ——
 * 常见的 `rm -rf` 变体必须全覆盖，`rm -r`（不带 force）不该拦。
 */

import { describe, expect, it } from "vitest";
import {
  assessPaste,
  countLines,
  MULTILINE_THRESHOLD
} from "@/terminal/lib/pasteGuard";

describe("countLines", () => {
  it("空行不算行数（脚本常用空行分段）", () => {
    expect(countLines("a\n\n\nb\n")).toBe(2);
  });

  it("纯空白行也不算", () => {
    expect(countLines("  \n\t\n")).toBe(0);
  });
});

describe("行数阈值", () => {
  it("三行以内不因行数提示", () => {
    const text = "cd /tmp\nls\necho done";
    expect(assessPaste(text).risky).toBe(false);
  });

  it("超过三行提示，并带上行数", () => {
    const text = "cd /tmp\nls\necho a\necho b";
    const result = assessPaste(text);
    expect(result.risky).toBe(true);
    expect(result.lines).toBe(4);
    expect(result.risks).toEqual([
      { id: "multiline", lines: 4 }
    ]);
    expect(MULTILINE_THRESHOLD).toBe(3);
  });

  it("空行不把两条命令撑成多行", () => {
    expect(assessPaste("ls\n\n\n\n").risky).toBe(
      false
    );
  });
});

describe("rm -rf 的各种写法", () => {
  it("合并短选项", () => {
    for (const command of [
      "rm -rf /data",
      "rm -fr /data",
      "rm -Rf /data",
      "rm -rfv /data"
    ]) {
      expect(assessPaste(command).risks).toEqual([
        { id: "rm-rf" }
      ]);
    }
  });

  it("分开写短选项", () => {
    expect(
      assessPaste("rm -r -f /data").risks
    ).toEqual([{ id: "rm-rf" }]);
  });

  it("长选项", () => {
    expect(
      assessPaste("rm --recursive --force /data")
        .risks
    ).toEqual([{ id: "rm-rf" }]);
  });

  it("只有 -r 不算（普通递归删除要用户自己确认，不该抢）", () => {
    expect(assessPaste("rm -r build").risky).toBe(
      false
    );
  });

  it("别的命令里出现 rm 字样不误判", () => {
    expect(
      assessPaste("echo rm -rf").risks
    ).toEqual([{ id: "rm-rf" }]);
  });
});

describe("其它危险模式", () => {
  it("dd 写设备", () => {
    expect(
      assessPaste(
        "dd if=/dev/zero of=/dev/sda bs=1M"
      ).risks
    ).toEqual([{ id: "dd" }]);
  });

  it("mkfs（含子命令）", () => {
    expect(
      assessPaste("mkfs.ext4 /dev/sdb1").risks
    ).toEqual([{ id: "mkfs" }]);
  });

  it("chmod 777 根目录", () => {
    expect(
      assessPaste("chmod -R 777 /").risks
    ).toEqual([{ id: "chmod-root" }]);
  });

  it("chmod 777 具体目录不拦", () => {
    expect(
      assessPaste("chmod -R 777 /var/www").risky
    ).toBe(false);
  });

  it("fork bomb", () => {
    expect(
      assessPaste(":(){ :|:& };:").risks
    ).toEqual([{ id: "fork-bomb" }]);
  });
});

describe("组合", () => {
  it("多行 + 危险模式一起报，同一类只报一次", () => {
    const text = [
      "cd /srv",
      "rm -rf ./cache",
      "rm -rf ./logs",
      "tar czf backup.tgz ."
    ].join("\n");
    const result = assessPaste(text);
    expect(result.risky).toBe(true);
    expect(result.lines).toBe(4);
    expect(result.risks).toEqual([
      { id: "multiline", lines: 4 },
      { id: "rm-rf" }
    ]);
  });

  it("普通脚本（vi 脚本、部署脚本）不拦", () => {
    const text = [
      "set -e",
      "git fetch origin",
      "git checkout main",
      "git pull"
    ].join("\n");
    // 4 行 → 仍会因行数提示（这是刻意的：粘脚本就该看一眼）
    expect(assessPaste(text).risks).toEqual([
      { id: "multiline", lines: 4 }
    ]);
  });
});
