/**
 * OSC 7（当前工作目录）的解析。
 *
 * 远端钩子在每次画提示符前发一条 `ESC ] 7 ; file://<host>/<path> BEL`，
 * 终端据此知道 shell 现在在哪个目录 —— 这就是目录栏「实时跟随」的数据源。
 *
 * 为什么不用别的办法：
 * - 定期跑 `pwd` 会污染命令历史与终端输出，用户看得见；
 * - 从提示符文本里抠 `~` / 路径只能覆盖默认 PS1，oh-my-zsh / starship 的
 *   提示符里根本没有可解析的路径；
 * - OSC 7 是 iTerm2 / VTE / Windows Terminal 都在用的标准做法。
 */

/**
 * 从 OSC 7 的载荷里取出目录。
 *
 * 认三种形态：
 * - `file://host/path`（标准，host 可能为空）
 * - `/abs/path`（部分实现省略 `file://`）
 * - `C:/Users/...` 或 `C:\Users\...`（Windows / PowerShell）
 *
 * @param data OSC 7 的内容（不含 `ESC ] 7 ;` 与终止符）
 * @returns 目录路径（统一正斜杠）；认不出来返回 null
 */
export function parseOsc7(
  data: string
): string | null {
  const raw = data.trim();
  if (!raw) return null;
  let path: string;
  if (raw.startsWith("file://")) {
    // 跳过 "file://" 与主机名，从第一个 "/" 开始才是路径
    const rest = raw.slice("file://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    path = rest.slice(slash);
  } else if (/^[A-Za-z]:[\\/]/.test(raw)) {
    // Windows 盘符路径（PowerShell 的 $PWD 是反斜杠）
    return raw.replace(/\\/g, "/");
  } else if (raw.startsWith("/")) {
    path = raw;
  } else {
    return null;
  }
  try {
    // 路径里可能有 %20 之类；解不开就按原样用（宁可显示错也不丢目录）
    path = decodeURIComponent(path) || "/";
  } catch {
    // 保留原始 path
  }
  // Windows 惯例是 `file://host/C:/Users/x`，多出来的前导斜杠要去掉，
  // 否则 `fs_list_dir("C:/…")` 会认成相对路径
  return path.replace(/^\/([A-Za-z]:\/)/, "$1");
}

/**
 * 从提示符文本里猜当前目录（**OSC 7 没来时的兜底**）。
 *
 * 为什么需要：钩子要部署 + 新 shell 才加载，升级前的老会话没有 OSC 7，
 * 目录栏就永远停在初始目录。而绝大多数 PS1 都把 `\w` / `$PWD` 画在
 * 提示符里（`root@host:/var/log#`、`[user@host ~]$`、`PS C:\Users\x>`），
 * 从这一行里取最后一个「像路径的 token」就能跟上。
 *
 * 只认三种形态，认不出就返回 null（宁可不动，也不跳到错目录）：
 * - 绝对路径 `/…`
 * - 家目录简写 `~` / `~/…`
 * - Windows 盘符 `C:\…` / `C:/…`（统一转正斜杠）
 *
 * @param prompt 提示符那一行的文本（不含命令输入）
 */
export function parsePromptCwd(
  prompt: string
): string | null {
  if (!prompt) return null;
  // Windows 盘符要单独先认：`PS C:\Users\x>` 的冒号若走下面「按 : 拆
  // token」会把路径拆碎（C / \Users\x）
  // ⚠️ 前面必须是行首或空白：否则 `root@host:/var/log` 里的 `t:/`
  // 会被当成 "t 盘"
  const win =
    /(?:^|\s)([A-Za-z]:[\\/][^\s#$%>]*)\s*[#$%>]?\s*$/.exec(
      prompt
    );
  if (win?.[1]) return win[1].replace(/\\/g, "/");
  // 去掉末尾的提示符符号（# $ % >）再拆 token：
  // `root@h:/var/log#` → `root@h:/var/log`
  const cleaned = prompt
    .replace(/[#$%>]+\s*$/, "")
    .trimEnd();
  // filter 掉空段：`[user@host ~]` 这类首尾的分隔符会切出空串，
  // 直接取最后一个会拿到 ""
  const tokens = cleaned
    .split(/[\s:[\]]+/)
    .filter(Boolean);
  const last = tokens[tokens.length - 1] ?? "";
  if (!last) return null;
  if (last === "~" || last.startsWith("~/"))
    return last;
  if (
    last.startsWith("/") &&
    !last.startsWith("//")
  )
    return last;
  return null;
}
