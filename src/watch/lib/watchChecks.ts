/**
 * 巡检的采集脚本与解析。
 *
 * ## 一次 exec 拿齐所有指标
 *
 * 每多一次 exec 就多一次 ssh 握手/通道开销，也更容易被服务器当成异常流量。
 * 所以把启用的检查项拼成**一条**脚本，用 `===W:NAME===` 分节，一次执行
 * 全部解析回来 —— 与 `terminal/lib/sysInfo.ts` 的 `SYS_SCRIPT` 同一套做法。
 *
 * ## CPU 一定要两次采样
 *
 * `/proc/stat` 给的是**开机以来的累计值**，单读一次只能算出「历史平均」，
 * 对「现在有没有炸」毫无意义。脚本里用 `sleep 1` 夹住两次读取，用差值
 * 算占用率 —— 这也是 top 的做法。
 *
 * ## 只读是「守卫」，不是沙箱
 *
 * 自定义命令这条口子给了用户执行任意文本的能力，`assertReadOnly` 只能拦掉
 * 一批常见写操作的关键词。真正的边界是：**这段脚本由用户自己配置、在他
 * 自己的服务器上跑**，与他在终端里敲是同一个人。别把它当成权限隔离。
 */

import type {
  WatchCheck,
  WatchCheckKind,
  WatchSample
} from "@/watch/lib/watchTypes";

/** 分节标记前缀。用全大写 + 冒号，避免与常见输出撞车。 */
const MARK = "===W:";

/** 原始输出保留上限（字符）：留给事后归因，再长就是在囤垃圾。 */
export const RAW_LIMIT = 4000;

/** 自定义命令输出保留上限，用于展示。 */
const CMD_OUTPUT_LIMIT = 1000;

/**
 * 写操作关键词黑名单。
 *
 * 故意粗糙：这里的目标是让「手滑把 `rm -rf` 填进巡检框」当场被拦下并
 * 提示，而不是造一个能对抗恶意用户的解析器（见文件头注释）。
 */
const DANGEROUS_TOKENS = [
  "rm ",
  "rmdir",
  "mv ",
  "cp ",
  "dd ",
  "mkfs",
  "fdisk",
  "parted",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "kill",
  "pkill",
  "killall",
  "systemctl restart",
  "systemctl stop",
  "systemctl start",
  "systemctl disable",
  "service ",
  "chmod",
  "chown",
  "useradd",
  "userdel",
  "passwd",
  "iptables",
  "ufw ",
  "apt ",
  "apt-get",
  "yum ",
  "dnf ",
  "pip install",
  "npm i",
  "npm install",
  "docker rm",
  "docker stop",
  "docker restart",
  "truncate",
  "tee ",
  "> ",
  ">> ",
  "| sh",
  "| bash",
  "curl -o",
  "wget "
];

/**
 * 校验自定义命令是否像一条只读命令。
 *
 * @returns null = 通过；否则返回给用户看的拒绝原因
 */
export function assertReadOnly(
  command: string
): string | null {
  const text = command.trim();
  if (!text) return "命令不能为空";
  const lower = text.toLowerCase();
  for (const token of DANGEROUS_TOKENS) {
    if (lower.includes(token))
      return `值守巡检只允许只读命令（检测到「${token.trim()}」）`;
  }
  return null;
}

/** 单引号包裹并转义内部单引号，防止用户输入的单元名/挂载点破坏脚本结构。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 是否是「安全词」（单元名、挂载点）。
 *
 * 只放行字母数字与 `@ . / : - _`：这些是 systemd 单元名与路径里真正会
 * 出现的字符，其它一律不带进脚本 —— 拼进去就是在给 shell 送参数。
 */
export function isSafeWord(
  value: string
): boolean {
  return /^[\w@./:-]+$/.test(value);
}

/** 只允许字母数字与少量符号的「安全词」（单元名、挂载点）。 */
function safeWord(value: string): string {
  return isSafeWord(value) ? value : "";
}

/**
 * 生成采集脚本。
 *
 * 只拼**启用**的检查项：全关的会话不该跑任何命令（省一次 exec，
 * 也避免 `systemctl` 之类在不支持的机器上白报错）。
 *
 * @param checks 该会话的检查项
 */
export function buildWatchScript(
  checks: WatchCheck[]
): string {
  const on = (kind: WatchCheckKind) =>
    checks.some(
      c => c.enabled && c.kind === kind
    );
  const lines: string[] = [];
  const needStat = on("cpu");

  // 顺序刻意让两次 /proc/stat 读取夹住中间的采集：sleep 期间正好干别的
  if (needStat)
    lines.push(
      `echo "${MARK}STAT1==="; head -1 /proc/stat`
    );
  if (on("mem"))
    lines.push(
      `echo "${MARK}MEM==="; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo`
    );
  if (on("load"))
    lines.push(
      `echo "${MARK}LOAD==="; cut -d" " -f1,2,3 /proc/loadavg; nproc`
    );
  if (on("disk"))
    lines.push(
      `echo "${MARK}DF==="; df -P 2>/dev/null`
    );
  const units = checks
    .filter(
      c => c.enabled && c.kind === "service"
    )
    .map(c => safeWord((c.unit ?? "").trim()))
    .filter(Boolean);
  if (units.length > 0) {
    // `|| true`：单元不存在时 is-active 退出码是 3，
    // 不加的话脚本会在 set -e 的登录 shell 里提前中断
    const body = units
      .map(
        unit =>
          `printf "%s " ${quote(unit)}; systemctl is-active ${quote(unit)} 2>/dev/null || true`
      )
      .join("; ");
    lines.push(`echo "${MARK}SVC==="; ${body}`);
  }
  const custom = checks.find(
    c => c.enabled && c.kind === "command"
  );
  if (custom?.command?.trim()) {
    // 先记退出码再 echo：`echo` 自己会把 $? 改成 0，
    // 直接 `cmd; echo "EXIT=$?"` 拿到的永远是上一条 echo 的码
    lines.push(
      `echo "${MARK}CMD==="; ${custom.command.trim()}; __w_code=$?; echo "${MARK}EXIT==="; echo $__w_code`
    );
  }
  if (needStat) {
    // sleep 放在最后一段之前：这段等待本身就是两次 stat 的采样间隔
    lines.push("sleep 1");
    lines.push(
      `echo "${MARK}STAT2==="; head -1 /proc/stat`
    );
  }
  return lines.join("\n");
}

/**
 * 把输出按 `===W:NAME===` 分节。
 *
 * 逐行扫而不是用正则切：标记可能**和值同处一行**（`===W:EXIT===` 后面
 * 紧跟一行退出码，而命令本身可能一个字符都不输出），正则切法在这种
 * 「空分节」上会把下一个标记当成内容，表现为退出码永远是 0 —— 自定义
 * 检查项因此永远判「正常」。
 */
function sections(
  stdout: string
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current = "";
  for (const raw of stdout.split("\n")) {
    if (raw.startsWith(MARK)) {
      const close = raw.indexOf(
        "===",
        MARK.length
      );
      const name =
        close < 0
          ? raw.slice(MARK.length)
          : raw.slice(MARK.length, close);
      current = name;
      const rest =
        close < 0 ? "" : raw.slice(close + 3);
      // 标记同一行带出来的值（如 `===W:EXIT===0`）
      out[current] = rest.trim()
        ? [rest.trim()]
        : [];
      continue;
    }
    if (current)
      out[current]?.push(raw.trimEnd());
  }
  return out;
}

/** 取某个分节；没有则返回空数组。 */
function section(
  parts: Record<string, string[]>,
  name: string
): string[] {
  return parts[name] ?? [];
}

/** `/proc/stat` 一行 → 数值数组（跳过开头的 `cpu`）。 */
function parseStat(line: string): number[] {
  return line
    .replace(/^cpu\s+/, "")
    .split(/\s+/)
    .map(Number)
    .filter(n => Number.isFinite(n));
}

/**
 * 两次 `/proc/stat` → CPU 占用率（%）。
 *
 * 口径与 `sysInfo.ts` 一致：`100 - idle - iowait`。把 iowait 算作空闲，
 * 是因为 IO 等待时 CPU 确实没在算 —— 算成占用会让「磁盘慢」被误读成
 * 「CPU 高」，两份面板给出互相矛盾的数字。
 */
export function cpuUsageOf(
  first: number[],
  second: number[]
): number | null {
  if (!first.length || !second.length)
    return null;
  const delta = second.map(
    (value, index) => value - (first[index] ?? 0)
  );
  const total = delta.reduce(
    (sum, value) => sum + value,
    0
  );
  // 两次采样之间计数器没动（极端空闲或时钟异常）→ 不做判断
  if (total <= 0) return null;
  const idle =
    ((delta[3] ?? 0) + (delta[4] ?? 0)) / total;
  return Math.min(
    100,
    Math.max(0, (1 - idle) * 100)
  );
}

/** `df -P` 输出 → 挂载点 → 使用率。 */
export function parseDf(
  lines: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(/\s+/);
    if (cols[0] === "Filesystem") continue;
    // -P 保证每行 6 列，最后一列是挂载点（可能含空格 → 拼回去）
    if (cols.length < 6) continue;
    const pct = Number(
      (cols[4] ?? "").replace("%", "")
    );
    if (!Number.isFinite(pct)) continue;
    out[cols.slice(5).join(" ")] = pct;
  }
  return out;
}

/**
 * 解析采集脚本的输出。
 *
 * 缺分节时对应字段给 `null` / 空对象而不是抛错：巡检脚本在别人的服务器上
 * 跑，`df` 不存在、`systemctl` 是 chroot 里的假壳，这些都得活下来 ——
 * 一次解析失败不该让整轮巡检变成「一切正常」。
 *
 * @param stdout 脚本标准输出
 * @param at 采样时刻
 */
export function parseWatchSample(
  stdout: string,
  at = Date.now()
): WatchSample {
  const parts = sections(stdout);
  const memLines = section(parts, "MEM");
  const memTotal = Number(
    memLines
      .find(l => l.startsWith("MemTotal:"))
      ?.split(/\s+/)[1] ?? 0
  );
  const memAvailable = Number(
    memLines
      .find(l => l.startsWith("MemAvailable:"))
      ?.split(/\s+/)[1] ?? 0
  );
  const loadLines = section(parts, "LOAD").filter(
    Boolean
  );
  const load1 = Number(
    loadLines[0]?.split(/\s+/)[0]
  );
  const cores = Number(loadLines[1]) || 0;
  const svcLines = section(parts, "SVC");
  const services: Record<string, string> = {};
  for (const line of svcLines) {
    const [unit = "", state = ""] = line
      .split(/\s+/)
      .filter(Boolean);
    if (unit) services[unit] = state || "unknown";
  }
  const cmdLines = section(parts, "CMD");
  const exitLine =
    section(parts, "EXIT")[0] ?? "";
  const commandOutput = cmdLines
    .join("\n")
    .trim()
    .slice(0, CMD_OUTPUT_LIMIT);
  const cpu = cpuUsageOf(
    parseStat(section(parts, "STAT1")[0] ?? ""),
    parseStat(section(parts, "STAT2")[0] ?? "")
  );
  return {
    at,
    ok: true,
    cpu,
    // MemAvailable 才是「还能用多少」；用 MemFree 会把缓存算成已用，
    // 那台机器看着永远快满了
    mem:
      memTotal > 0 && memAvailable > 0
        ? ((memTotal - memAvailable) / memTotal) *
          100
        : null,
    load:
      Number.isFinite(load1) && cores > 0
        ? load1 / cores
        : null,
    cores,
    disks: parseDf(section(parts, "DF")),
    services,
    commandOutput,
    commandExit: Number(exitLine) || 0,
    raw: stdout.slice(0, RAW_LIMIT)
  };
}

/**
 * 取某个检查项本次的数值。
 *
 * @returns null 表示「这次取不到，不参与判定」（不是 0，也不是越界）
 */
export function checkValue(
  check: WatchCheck,
  sample: WatchSample
): number | null {
  switch (check.kind) {
    case "cpu":
      return sample.cpu;
    case "mem":
      return sample.mem;
    case "load":
      return sample.load;
    case "disk": {
      const mount =
        (check.mount ?? "").trim() || "/";
      return sample.disks[mount] ?? null;
    }
    case "service": {
      const unit = (check.unit ?? "").trim();
      if (!unit) return null;
      const state = sample.services[unit];
      // unknown / 空 = 这台机器没 systemd 或者单元名校验没过，
      // 此时判「挂了」就是误报 —— 宁可这个检查项空转
      if (!state || state === "unknown")
        return null;
      return state === "active" ? 1 : 0;
    }
    case "command": {
      if (!check.command?.trim()) return null;
      const expect = (check.expect ?? "").trim();
      const matched = expect
        ? sample.commandOutput.includes(expect)
        : true;
      return sample.commandExit === 0 && matched
        ? 1
        : 0;
    }
    default:
      return null;
  }
}

/** 该值是否越过红线。 */
export function isBreach(
  check: WatchCheck,
  value: number
): boolean {
  if (
    check.kind === "service" ||
    check.kind === "command"
  )
    return value < 1;
  return value > check.threshold;
}

/** 检查项的展示名（给通知与面板用，不带 i18n —— 由调用方套壳）。 */
export function checkSubject(
  check: WatchCheck
): string {
  switch (check.kind) {
    case "disk":
      return (check.mount ?? "").trim() || "/";
    case "service":
      return (
        (check.unit ?? "").trim() || "service"
      );
    case "command":
      return (
        (check.command ?? "").trim() || "command"
      );
    default:
      // CPU / 内存 / 负载没有「对象」：它们的标识就是指标本身。
      // 早先这里返回 `check.kind`，于是告警列表里出现「告警 mem」这种
      // 内部枚举漏到界面上的文字（2026-10-25 用户反馈）。
      // 空串同时参与 `checkKey` 的拼装，读写两端一致，不影响匹配。
      return "";
  }
}
