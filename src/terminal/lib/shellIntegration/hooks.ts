/**
 * 远端 shell 钩子脚本与安装命令。
 *
 * 三段脚本干的是同一件事：在提示符与命令边界输出 OSC 133 标记。
 *
 * - **bash**：`PROMPT_COMMAND` 发 `D`/`A`，`PS0`（4.4+）发 `C`，
 *   `PS1` 首尾各插一个标记负责 `A`/`B`。
 * - **zsh**：`precmd`/`preexec` 钩子（原生支持，无需 hack）+ `PROMPT`
 *   首尾标记。
 * - **pwsh**：重写 `prompt` 发 `D`/`A`/`B`，PSReadLine 的 `Enter`
 *   处理器发 `C`（PowerShell 没有 preexec 钩子）。
 *
 * ## 三条纪律
 *
 * 1. **不覆写用户配置**：只往 rc 追加带标记的 source 行，已有就跳过；
 *    提示符包裹用 `*]133;B*` 判断幂等，`starship`/`p10k` 这类每次都重设
 *    `PS1`/`PROMPT` 的框架也不会被我们叠出多层标记。
 * 2. **不抢钩子**：bash 用 `PS0` 而不是 `DEBUG` trap（后者会顶掉用户的
 *    trap）；`PROMPT_COMMAND` 按数组/字符串两种形态分别追加，不整体赋值。
 * 3. **可手动卸载**：脚本带 `v1` 版本行，删文件 + 删 rc 里那两行即可；
 *    版本升级时 `deploy.ts` 会重写文件、rc 里的 source 行保持不变。
 */

/** 支持自动部署的远端 shell。 */
export type RemoteShell = "bash" | "zsh" | "pwsh";

/** 钩子协议版本：脚本语义有变动时 +1，deploy 据此决定要不要重装。 */
export const HOOK_VERSION = 4;

/** rc 文件里用来识别「这一行是我们加的」的标记。 */
export const RC_MARKER =
  "# >>> tera-shell shell integration >>>";

/** 远端钩子目录（与 vim 配色部署同源，`~` 下自留地）。 */
export const HOOK_DIR = "$HOME/.tera-shell/hooks";

/**
 * bash 钩子脚本。
 *
 * ⚠️ `PS1` 里的 `\[ \]` 不能省：readline 靠它区分「非打印序列」，
 * 少了它就会把 ESC 序列的长度算进提示符宽度 —— 长命令换行错位、
 * 光标跑偏，症状看着像终端坏了。
 */
const BASH_HOOK = [
  `# >>> tera-shell shell integration v${HOOK_VERSION} >>>`,
  `# 由 Tera Shell 自动部署（OSC 133 命令边界标记），请勿手改。`,
  `# 卸载：删掉本文件，并删掉 ~/.bashrc 里 source 本文件的那一行。`,
  `[[ -n \${__TERA_SI_LOADED:-} ]] && return 0`,
  `__TERA_SI_LOADED=1`,
  `__TERA_SI_VERSION=${HOOK_VERSION}`,
  ``,
  `__tera_si_osc() { builtin printf '\\033]133;%s\\007' "$1"; }`,
  ``,
  `# 提示符首尾标记：A 在提示符前、B 在其后（B 的位置就是输入起点）。`,
  `# A 只放在 PS1 前缀里 —— precmd 里再发一次会变成每个提示符两个 A。`,
  `# 幂等：已经是包裹过的 PS1 就不再套一层。`,
  `__tera_si_wrap_ps1() {`,
  `  [[ -n \${PS1:-} && $PS1 == *']133;B'* ]] && return 0`,
  `  PS1="\\[\\e]133;A\\a\\]\${PS1:-}\\[\\e]133;B\\a\\]"`,
  `}`,
  ``,
  `# 命令即将执行：PS0 在读完一整条命令行之后、执行之前展开，`,
  `# 是 bash 自带的 preexec 钩子，且不会抢用户的 DEBUG trap。`,
  `# bash < 4.4 没有 PS0，那就不装 C —— 回车时仍能靠 B 定位读到命令行，`,
  `# 只是拿不到 Tab 补全展开后的最终形态。`,
  `if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then`,
  `  if [[ \${PS0:-} != *']133;C'* ]]; then`,
  `    PS0=$'\\e]133;C\\a'"\${PS0:-}"`,
  `  fi`,
  `fi`,
  ``,
  `# D（结束 + 退出码）。A 由 PS1 前缀负责，这里不再重复发。`,
  `# ⚠️ $? 必须在函数第一行取走，后面任何命令都会覆盖它。`,
  `__tera_si_precmd() {`,
  `  local code=$?`,
  `  __tera_si_osc "D;exit=\${code}"`,
  // OSC 7：当前工作目录。目录栏靠它「实时跟随」——每画一次提示符就报
  // 一次，`cd` 之后自然就更新了。用 $PWD 而不是 pwd，省一次子进程。
  `  __tera_si_osc "7;file://\${HOSTNAME:-localhost}\${PWD}"`,
  `  __tera_si_wrap_ps1`,
  `  return $code`,
  `}`,
  ``,
  `__tera_si_wrap_ps1`,
  ``,
  `# PROMPT_COMMAND 在 bash 5.1+ 是数组、更早是字符串。直接赋值会顶掉`,
  `# 用户原有的 precmd（starship 之类全靠它），必须按类型追加。`,
  `# ⚠️ 必须排在**最前面**：追加到末尾的话，前面的 precmd（starship/conda）`,
  `# 先跑，$? 已经被它们改成自己的退出码，__tera_si_precmd 里读到的永远是 0`,
  `# —— 表现就是「失败命令从来不提示、历史里也没有退出码」。`,
  `if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then`,
  `  PROMPT_COMMAND=(__tera_si_precmd "\${PROMPT_COMMAND[@]}")`,
  `else`,
  `  PROMPT_COMMAND="__tera_si_precmd\${PROMPT_COMMAND:+;\${PROMPT_COMMAND}}"`,
  `fi`
].join("\n");

/** zsh 钩子脚本：precmd/preexec 是原生钩子，比 bash 那套干净得多。 */
const ZSH_HOOK = [
  `# >>> tera-shell shell integration v${HOOK_VERSION} >>>`,
  `# 由 Tera Shell 自动部署（OSC 133 命令边界标记），请勿手改。`,
  `# 卸载：删掉本文件，并删掉 ~/.zshrc 里 source 本文件的那一行。`,
  `[[ -n \${__TERA_SI_LOADED:-} ]] && return 0`,
  `typeset -g __TERA_SI_LOADED=1`,
  `typeset -g __TERA_SI_VERSION=${HOOK_VERSION}`,
  ``,
  `__tera_si_osc() { print -rn -- $'\\e]133;'$1$'\\a' }`,
  ``,
  `# %{...%} 是 zsh 的「非打印序列」定界符，作用同 bash 的 \\[ \\]。`,
  `# A 只放在 PROMPT 前缀里 —— precmd 里再发一次会出现两个 A。`,
  `__tera_si_wrap_prompt() {`,
  `  [[ -n \${PROMPT:-} && $PROMPT == *']133;B'* ]] && return 0`,
  `  PROMPT=$'%{\\e]133;A\\a%}'"\${PROMPT:-}"$'%{\\e]133;B\\a%}'`,
  `}`,
  ``,
  `__tera_si_precmd() {`,
  `  local code=$?`,
  `  __tera_si_osc "D;exit=\${code}"`,
  // OSC 7：当前工作目录（zsh 里 $PWD 与 bash 同义）
  `  __tera_si_osc "7;file://\${HOST:-localhost}\${PWD}"`,
  `  __tera_si_wrap_prompt`,
  `  return $code`,
  `}`,
  ``,
  `__tera_si_preexec() { __tera_si_osc C }`,
  ``,
  `autoload -Uz add-zsh-hook`,
  `add-zsh-hook precmd __tera_si_precmd`,
  `# ⚠️ add-zsh-hook 是**追加**：排在前面的 precmd 会先跑，$? 已经变成它自己`,
  `# 的退出码。挪到最前面，__tera_si_precmd 里的 local code=$? 才拿得到`,
  `# 上一条命令的真实退出码。`,
  `precmd_functions=(__tera_si_precmd \${precmd_functions:#__tera_si_precmd})`,
  `add-zsh-hook preexec __tera_si_preexec`,
  `__tera_si_wrap_prompt`
].join("\n");

/**
 * PowerShell 钩子脚本。
 *
 * ⚠️ `B` 必须跟着提示符文本一起返回：`prompt` 的返回值由宿主打印，
 * 提前用 `Write-Host` 输出会让 B 落在提示符**前面**，输入起点就全错了。
 */
const PWSH_HOOK = [
  `# >>> tera-shell shell integration v${HOOK_VERSION} >>>`,
  `# 由 Tera Shell 自动部署（OSC 133 命令边界标记），请勿手改。`,
  `if ($global:__TeraSiLoaded) { return }`,
  `$global:__TeraSiLoaded = $true`,
  `$global:__TeraSiVersion = ${HOOK_VERSION}`,
  ``,
  `$global:__TeraSiOrigPrompt = $function:prompt`,
  ``,
  `function global:__TeraSiOsc([string]$Code) {`,
  `  return "$([char]27)]133;$Code$([char]7)"`,
  `}`,
  ``,
  `# D（上条命令的退出码）→ A → 原标题 → B。`,
  `function global:prompt {`,
  `  $ok = $?`,
  `  $code = $global:LASTEXITCODE`,
  `  # 成功时必须归零：$LASTEXITCODE 是**上一次原生命令**留下的旧值，`,
  `  # 这次跑的是纯 PowerShell 命令时它还停在 1，会把成功判成失败。`,
  `  if ($ok) { $code = 0 } elseif (-not $code) { $code = 1 }`,
  `  $text = & $global:__TeraSiOrigPrompt`,
  // OSC 7：当前工作目录。PowerShell 的 $PWD 用反斜杠，转成正斜杠
  // （OSC 7 与我们的目录列表都用 /）
  `  $cwdPath = ($PWD.Path -replace '\\\\', '/')`,
  `  return "$(__TeraSiOsc "D;exit=$code")$(__TeraSiOsc 'A')$(__TeraSiOsc "7;file://$env:COMPUTERNAME/$cwdPath")$text$(__TeraSiOsc 'B')"`,
  `}`,
  ``,
  `# C（命令开始）：PowerShell 没有 preexec 钩子，挂在 PSReadLine 的`,
  `# Enter 上。OSC 不占列，写在 AcceptLine 之前不会打乱行宽。`,
  `if (Get-Module -Name PSReadLine) {`,
  `  Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {`,
  `    [Console]::Write("$([char]27)]133;C$([char]7)")`,
  `    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()`,
  `  }`,
  `}`
].join("\n");

/** 取某种 shell 的钩子脚本文本。 */
export function hookScript(
  shell: RemoteShell
): string {
  switch (shell) {
    case "bash":
      return BASH_HOOK;
    case "zsh":
      return ZSH_HOOK;
    case "pwsh":
      return PWSH_HOOK;
  }
}

/** 钩子文件在远端的落盘路径（`$HOME` 字面量，由远端 shell 展开）。 */
export function hookPath(
  shell: RemoteShell
): string {
  return `${HOOK_DIR}/shell-integration.${shell}`;
}

/** 需要追加 source 行的 rc 文件（`$HOME` 字面量）。 */
export function rcPath(
  shell: RemoteShell
): string {
  switch (shell) {
    case "bash":
      return "$HOME/.bashrc";
    case "zsh":
      return "$HOME/.zshrc";
    case "pwsh":
      return "$HOME/.config/powershell/profile.ps1";
  }
}

/**
 * 探测远端登录 shell 类型。
 *
 * 看 `$SHELL` 而不看 `ps` 的父进程：ssh 登录 shell 一定由 passwd 决定，
 * `$SHELL` 正是它；而 `ps` 在最小化镜像里可能没有。
 */
export const DETECT_SHELL_COMMAND = [
  `s=$(basename "\${SHELL:-sh}" 2>/dev/null)`,
  `case "$s" in`,
  `  bash|zsh|pwsh) printf '%s\\n' "$s" ;;`,
  `  *) printf 'none\\n' ;;`,
  `esac`
].join("\n");

/**
 * 生成「写钩子文件 + 幂等挂到 rc」的远端命令。
 *
 * 全程 `set -e`：任何一步失败（home 只读、rc 不可写）都让 exec 返回
 * 非零，前端据此记「未部署」，本次连接退回启发式 —— 绝不留下半个
 * 配置把用户 shell 搞坏。
 *
 * @param shell 目标 shell
 */
export function buildInstallCommand(
  shell: RemoteShell
): string {
  const rc = rcPath(shell);
  const hook = hookPath(shell);
  return [
    `set -e`,
    `mkdir -p ${HOOK_DIR}`,
    `cat > "${hook}" <<'TERA_SI_HOOK_EOF'`,
    hookScript(shell),
    `TERA_SI_HOOK_EOF`,
    // 追加 source 行：带 marker 幂等，重复部署不会写两遍。
    // 每一步都 `|| true` + 末尾 `return 0`：`set -e` 下任何一步失败
    //（比如 rc 是只读的）都会让整个部署被判定为失败，但其实钩子文件
    // 已经写好了，没必要因此重试或报错。
    `marker='${RC_MARKER}'`,
    `__tera_si_add_rc() {`,
    `  _f="$1"`,
    `  if [ -f "$_f" ] && grep -qF "$marker" "$_f" 2>/dev/null; then`,
    `    return 0`,
    `  fi`,
    `  mkdir -p "$(dirname "$_f")" 2>/dev/null || true`,
    `  _src="[ -f \\"${hook}\\" ] && . \\"${hook}\\""`,
    `  printf '\\n%s\\n%s\\n' "$marker" "$_src" >> "$_f" 2>/dev/null || true`,
    `  return 0`,
    `}`,
    `__tera_si_add_rc "${rc}"`,
    // ⚠️ bash 的登录 shell（SSH 默认就是）读的是 profile 系列，
    // **不读 .bashrc**：只往 .bashrc 写 source 行的话，钩子在 SSH 会话里
    // 永远不加载（症状：`echo $PROMPT_COMMAND` 是空的、退出码拿不到、
    // 补全与历史一直走启发式兜底）。
    // 按登录 shell 的查找顺序补一份，已有的文件只追加、不覆盖。
    ...(shell === "bash"
      ? [
          `if [ -f "$HOME/.bash_profile" ]; then __tera_si_add_rc "$HOME/.bash_profile"`,
          `elif [ -f "$HOME/.bash_login" ]; then __tera_si_add_rc "$HOME/.bash_login"`,
          `elif [ -f "$HOME/.profile" ]; then __tera_si_add_rc "$HOME/.profile"`,
          // 三个都没有（很少见）：建 .bash_profile 并让它带我们这一行。
          // 不 source .bashrc 是有意的 —— 那是用户自己的文件，
          // 我们的职责只是把钩子挂上去。
          `else __tera_si_add_rc "$HOME/.bash_profile"; fi`
        ]
      : [])
  ].join("\n");
}
