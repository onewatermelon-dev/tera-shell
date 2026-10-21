/**
 * 远端钩子脚本与安装命令的测试。
 *
 * 这些字符串最终会被写进用户的 `.bashrc` / `.zshrc`，写坏了就是
 * 「终端提示符错乱」这种灾难级故障，所以把几处关键约束钉住：
 * 提示符包裹必须带非打印序列定界符、rc 追加必须幂等、rc 路径不能写错。
 */

import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  DETECT_SHELL_COMMAND,
  HOOK_VERSION,
  hookPath,
  hookScript,
  RC_MARKER,
  rcPath
} from "@/terminal/lib/shellIntegration/hooks";

describe("钩子脚本", () => {
  it("bash 用 PS0 发 C、PROMPT_COMMAND 发 D/A，且不碰 DEBUG trap", () => {
    const script = hookScript("bash");
    expect(script).toContain(
      "PS0=$'\\e]133;C\\a'"
    );
    expect(script).toContain("D;exit=");
    expect(script).toContain("PROMPT_COMMAND");
    // DEBUG trap 会顶掉用户自己的 trap，明确不许出现
    expect(script).not.toContain("trap ");
  });

  it("bash 的提示符包裹用 \\[ \\] 包住非打印序列", () => {
    const script = hookScript("bash");
    expect(script).toContain(
      'PS1="\\[\\e]133;A\\a\\]${PS1:-}\\[\\e]133;B\\a\\]"'
    );
  });

  it("bash 的 precmd 排在 PROMPT_COMMAND 最前面（否则 $? 被别人的 precmd 覆盖）", () => {
    const script = hookScript("bash");
    // 前置写法：数组首项就是我们的函数
    expect(script).toContain(
      'PROMPT_COMMAND=(__tera_si_precmd "${PROMPT_COMMAND[@]}")'
    );
    // 曾经的追加写法会让 starship/conda 先把 $? 改成 0
    expect(script).not.toContain(
      "PROMPT_COMMAND+=(__tera_si_precmd)"
    );
  });

  it("zsh 的 precmd 也排在最前面", () => {
    const script = hookScript("zsh");
    expect(script).toContain(
      "precmd_functions=(__tera_si_precmd"
    );
  });

  it("pwsh 成功时退出码归零（$LASTEXITCODE 是旧值）", () => {
    expect(hookScript("pwsh")).toContain(
      "if ($ok) { $code = 0 }"
    );
  });

  it("zsh 用原生 precmd/preexec 钩子", () => {
    const script = hookScript("zsh");
    expect(script).toContain(
      "add-zsh-hook precmd"
    );
    expect(script).toContain(
      "add-zsh-hook preexec"
    );
    // zsh 的非打印定界符
    expect(script).toContain("%{\\e]133;A\\a%}");
  });

  it("pwsh 从 prompt 返回值里带 B 标记（不能提前 Write）", () => {
    const script = hookScript("pwsh");
    expect(script).toContain("__TeraSiOsc 'B'");
    expect(script).toContain("PSReadLine");
  });

  it("每种脚本都带版本标记，便于升级时判断", () => {
    for (const shell of [
      "bash",
      "zsh",
      "pwsh"
    ] as const) {
      expect(hookScript(shell)).toContain(
        `shell integration v${HOOK_VERSION}`
      );
    }
  });

  it("钩子文件与 rc 路径按 shell 分开", () => {
    expect(hookPath("bash")).toBe(
      "$HOME/.tera-shell/hooks/shell-integration.bash"
    );
    expect(rcPath("bash")).toBe("$HOME/.bashrc");
    expect(rcPath("zsh")).toBe("$HOME/.zshrc");
  });
});

describe("安装命令", () => {
  it("先写钩子文件，再往 rc 追加带标记的 source 行", () => {
    const command = buildInstallCommand("bash");
    expect(command).toContain(
      "mkdir -p $HOME/.tera-shell/hooks"
    );
    expect(command).toContain("TERA_SI_HOOK_EOF");
    expect(command).toContain(RC_MARKER);
    expect(command).toContain(
      '__tera_si_add_rc "$HOME/.bashrc"'
    );
  });

  it("⚠️ bash 还要写登录 shell 的 profile 系列（它不读 .bashrc）", () => {
    const command = buildInstallCommand("bash");
    // 只写 .bashrc 的话，SSH 会话里 $PROMPT_COMMAND 是空的 ——
    // 钩子从未加载，退出码永远拿不到
    expect(command).toContain(
      '"$HOME/.bash_profile"'
    );
    expect(command).toContain(
      '"$HOME/.bash_login"'
    );
    expect(command).toContain('"$HOME/.profile"');
  });

  it("zsh 不需要 profile 系列（interactive shell 必读 .zshrc）", () => {
    expect(
      buildInstallCommand("zsh")
    ).not.toContain(".bash_profile");
  });

  it("rc 里已有标记时跳过追加（幂等）", () => {
    const command = buildInstallCommand("bash");
    expect(command).toContain(
      'grep -qF "$marker" "$_f"'
    );
    expect(command).toContain("return 0");
  });

  it("任何一步失败都不至于整体失败（rc 只读时钩子文件仍写好）", () => {
    const command = buildInstallCommand("bash");
    expect(command).toContain(
      '>> "$_f" 2>/dev/null || true'
    );
  });

  it("任何一步失败都让整体失败（set -e）", () => {
    for (const shell of [
      "bash",
      "zsh"
    ] as const) {
      expect(
        buildInstallCommand(shell).split("\n")[0]
      ).toBe("set -e");
    }
  });

  it("探测命令只看 $SHELL，认不出来返回 none", () => {
    expect(DETECT_SHELL_COMMAND).toContain(
      "${SHELL:-sh}"
    );
    expect(DETECT_SHELL_COMMAND).toContain(
      "printf 'none\\n'"
    );
  });
});
