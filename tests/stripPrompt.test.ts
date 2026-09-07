import { describe, expect, it } from "vitest";
import { stripPrompt } from "../src/utils/stripPrompt";

describe("stripPrompt", () => {
  it("剥离 PowerShell 提示符", () => {
    expect(
      stripPrompt(
        "PS C:\\User\\wate> cat /log/sys_log/run_log.log | grep SMU="
      )
    ).toBe(
      "cat /log/sys_log/run_log.log | grep SMU="
    );
  });
  it("剥离 bash/SSH 提示符", () => {
    expect(
      stripPrompt("root@host:~$ ls -la /tmp")
    ).toBe("ls -la /tmp");
    expect(
      stripPrompt(
        "user@10.0.0.5:/opt/app# tail -f run.log"
      )
    ).toBe("tail -f run.log");
  });
  it("命令自身含 > 时只剥提示符，不动命令", () => {
    expect(
      stripPrompt("PS C:\\x> echo a > b.txt")
    ).toBe("echo a > b.txt");
  });
  it("无提示符时返回空串（空串后端回退重建", () => {
    expect(
      stripPrompt("cat /log/sys_log/run_log.log")
    ).toBe("");
    expect(stripPrompt("")).toBe("");
  });
});
