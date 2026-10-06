/**
 * 系统信息采集：通过 SSH exec 通道跑一条聚合脚本，前端解析成结构化数据。
 *
 * 脚本输出用 `===NAME===` 分节；CPU 占用与网速靠对 /proc 采样两次求差
 * （间隔即脚本里的 sleep 1，近似值，见 ponytail 注释）。
 */

/** 聚合采集脚本：一次 exec 拿齐所有分区。 */
export const SYS_SCRIPT = `echo "===OS==="
. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
uname -r
uname -m
hostname
echo "===CPU==="
lscpu 2>/dev/null
grep -m1 BogoMIPS /proc/cpuinfo 2>/dev/null
echo "===STAT==="
head -1 /proc/stat
sleep 1
head -1 /proc/stat
echo "===MEM==="
grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|Shmem|SwapTotal|SwapFree):" /proc/meminfo
echo "===UPTIME==="
cut -d" " -f1 /proc/uptime
echo "===LOAD==="
cut -d" " -f1-3 /proc/loadavg
echo "===NET==="
cat /proc/net/dev
sleep 1
cat /proc/net/dev
echo "===DISK==="
df -hP 2>/dev/null`;

export type SysInfo = {
  os: string;
  kernel: string;
  arch: string;
  hostname: string;
  cpu: {
    name: string;
    cores: string;
    mhz: string;
    caches: string[];
    bogoMips: string;
  };
  /** /proc/stat 两次采样求差得到的各项占比（%） */
  cpuUsage: {
    user: number;
    nice: number;
    system: number;
    idle: number;
    iowait: number;
    irq: number;
    softirq: number;
    steal: number;
  };
  /** 总占用 = 100 - 空闲 - IO 等待 */
  cpuTotal: number;
  mem: {
    total: number;
    used: number;
    free: number;
    shared: number;
    cache: number;
    available: number;
  };
  swap: {
    total: number;
    used: number;
    free: number;
  };
  uptimeSec: number;
  load: string;
  net: {
    name: string;
    rx: number;
    tx: number;
    rxBps: number;
    txBps: number;
  }[];
  disks: {
    name: string;
    size: string;
    used: string;
    avail: string;
    usePct: string;
    mount: string;
  }[];
  /** 根分区用量（核心指标磁盘卡片） */
  rootDisk: { used: number; pct: number } | null;
};

/** 取 `===NAME===` 分节的行。 */
function section(
  stdout: string,
  name: string
): string[] {
  const matched = new RegExp(
    `===${name}===\\n([\\s\\S]*?)(?=\\n===|$)`
  ).exec(stdout);
  return (matched?.[1] ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

/** lscpu 一行里取 `键:` 后的值。 */
function lscpuValue(
  lines: string[],
  key: string
): string {
  const line = lines.find(l => l.startsWith(key));
  return line
    ? line.slice(line.indexOf(":") + 1).trim()
    : "";
}

function parseStat(line: string): number[] {
  return line
    .replace(/^cpu\s+/, "")
    .split(/\s+/)
    .map(Number)
    .filter(n => !Number.isNaN(n));
}

/** 两次 /proc/stat 采样 → 各项占比（%）。 */
function cpuUsageOf(
  first: number[],
  second: number[]
): SysInfo["cpuUsage"] {
  const delta = second.map(
    (v, i) => v - (first[i] ?? 0)
  );
  const total =
    delta.reduce((sum, v) => sum + v, 0) || 1;
  const pct = (i: number) =>
    ((delta[i] ?? 0) / total) * 100;
  return {
    user: pct(0),
    nice: pct(1),
    system: pct(2),
    idle: pct(3),
    iowait: pct(4),
    irq: pct(5),
    softirq: pct(6),
    steal: pct(7)
  };
}

/** /proc/net/dev 一次采样 → { 接口: [rx, tx] }。 */
function netSample(
  lines: string[]
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> =
    {};
  for (const line of lines) {
    const [name = "", ...fields] = line
      .split(/[:\s]+/)
      .filter(Boolean);
    // 字段序：rx bytes packets errs drop fifo frame compressed，
    // 然后 tx bytes 在第 9 个数值字段
    if (
      !name ||
      name === "Inter" ||
      name === "face"
    )
      continue;
    const rx = Number(fields[0]) || 0;
    const tx = Number(fields[8]) || 0;
    out[name] = [rx, tx];
  }
  return out;
}

/** 解析聚合脚本输出；缺分节时对应字段留空值而不是抛错。 */
export function parseSysInfo(
  stdout: string
): SysInfo {
  const osLines = section(stdout, "OS");
  const cpuLines = section(stdout, "CPU");
  const statLines = section(stdout, "STAT");
  const memLines = section(stdout, "MEM");
  const uptimeLines = section(stdout, "UPTIME");
  const loadLines = section(stdout, "LOAD");
  const netLines = section(stdout, "NET");
  const diskLines = section(stdout, "DISK");

  // /proc/net/dev 被 sleep 1 分成前后两段
  const devCount = netLines.filter(l =>
    l.includes(":")
  ).length;
  const half = Math.ceil(devCount / 2);
  let seen = 0;
  const firstHalf: string[] = [];
  const secondHalf: string[] = [];
  for (const line of netLines) {
    if (line.includes(":")) seen += 1;
    (seen <= half ? firstHalf : secondHalf).push(
      line
    );
  }
  const net1 = netSample(firstHalf);
  const net2 = netSample(secondHalf);
  // ponytail: 采样间隔按 1s 近似（脚本里 sleep 1），
  // 要精确值就在两端打时间戳，目前展示用途足够
  const net = Object.keys(net2).map(name => {
    const [rx = 0, tx = 0] = net2[name] ?? [];
    const [rx1 = rx, tx1 = tx] = net1[name] ?? [];
    return {
      name,
      rx,
      tx,
      rxBps: Math.max(0, rx - rx1),
      txBps: Math.max(0, tx - tx1)
    };
  });

  const meminfo = (key: string) => {
    const line = memLines.find(l =>
      l.startsWith(`${key}:`)
    );
    const kb = Number(line?.split(/\s+/)[1] ?? 0);
    return kb * 1024;
  };
  const memTotal = meminfo("MemTotal");
  const memAvailable = meminfo("MemAvailable");

  const disks = diskLines
    .filter(l => !l.startsWith("Filesystem"))
    .map(line => {
      const cols = line.split(/\s+/);
      return {
        name: cols[0] ?? "",
        size: cols[1] ?? "",
        used: cols[2] ?? "",
        avail: cols[3] ?? "",
        usePct: cols[4] ?? "",
        mount: cols.slice(5).join(" ")
      };
    });
  const root = disks.find(d => d.mount === "/");
  const rootUsed = root
    ? parseDfSizeGb(root.used)
    : null;

  const statFirst = statLines[0]
    ? parseStat(statLines[0])
    : [];
  const statSecond = statLines[1]
    ? parseStat(statLines[1])
    : [];
  const usage =
    statFirst.length && statSecond.length
      ? cpuUsageOf(statFirst, statSecond)
      : {
          user: 0,
          nice: 0,
          system: 0,
          idle: 100,
          iowait: 0,
          irq: 0,
          softirq: 0,
          steal: 0
        };

  return {
    os: osLines[0] ?? "",
    kernel: osLines[1] ?? "",
    arch: osLines[2] ?? "",
    hostname: osLines[3] ?? "",
    cpu: {
      name: lscpuValue(cpuLines, "Model name"),
      cores: lscpuValue(cpuLines, "CPU(s)"),
      mhz:
        lscpuValue(cpuLines, "CPU MHz") ||
        lscpuValue(cpuLines, "max MHz"),
      caches: cpuLines
        .filter(l => /^L[123]\w* cache:/.test(l))
        .map(l => l.replace(" cache", "")),
      bogoMips: lscpuValue(cpuLines, "BogoMIPS")
    },
    cpuUsage: usage,
    cpuTotal: 100 - usage.idle - usage.iowait,
    mem: {
      total: memTotal,
      used: memTotal - memAvailable,
      free: meminfo("MemFree"),
      shared: meminfo("Shmem"),
      cache:
        meminfo("Buffers") + meminfo("Cached"),
      available: memAvailable
    },
    swap: (() => {
      const total = meminfo("SwapTotal");
      const free = meminfo("SwapFree");
      return {
        total,
        used: total - free,
        free
      };
    })(),
    // /proc/uptime 一行两个数，取第一个（秒）
    uptimeSec:
      Number(uptimeLines[0]?.split(/\s+/)[0]) ||
      0,
    load: loadLines[0] ?? "",
    net,
    disks,
    rootDisk:
      root && rootUsed !== null
        ? {
            used: rootUsed,
            pct:
              Number(
                root.usePct.replace("%", "")
              ) || 0
          }
        : null
  };
}

/** df -h 的容量字符串（如 4.2G / 97M）→ 字节数。 */
function parseDfSizeGb(
  text: string
): number | null {
  const matched =
    /^([\d.]+)([KMGTPE])?i?B?$/i.exec(
      text.trim()
    );
  if (!matched) return null;
  const value = Number(matched[1]);
  const unit = (matched[2] ?? "B").toUpperCase();
  const units: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
    E: 1024 ** 6
  };
  return value * (units[unit] ?? 1);
}

/** 字节数 → 人类可读（1024 进制，一位小数）。 */
export function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${
    i === 0 ? value : value.toFixed(1)
  } ${units[i]}`;
}

/** 字节/秒 → 带单位速率。 */
export function fmtRate(
  bytesPerSec: number
): string {
  return `${fmtBytes(bytesPerSec)}/s`;
}

/** 秒 → 运行时长文本（如 77 days / 3 h 20 m）。 */
export function fmtUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  if (days > 0) return `${days} days`;
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  return hours > 0
    ? `${hours} h ${mins} m`
    : `${mins} m`;
}

/**
 * 进程采集脚本：`=` 抑制表头，args 放最后一列（含空格），
 * 默认按 PID 倒序（新进程在前）。
 */
export const PROC_SCRIPT =
  "ps -eo pid=,user=,%mem=,%cpu=,args= --sort=-pid";

export type ProcInfo = {
  pid: number;
  user: string;
  mem: number;
  cpu: number;
  cmd: string;
};

/**
 * 解析 ps 输出。aiRunCommand 的包装前导行（hostname/pwd/---）
 * 不匹配「数字 用户 数 数 命令」的行式，天然被跳过。
 */
export function parseProcesses(
  stdout: string
): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const matched =
      /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/.exec(
        line
      );
    if (!matched) continue;
    out.push({
      pid: Number(matched[1]),
      user: matched[2] ?? "",
      mem: Number(matched[3]) || 0,
      cpu: Number(matched[4]) || 0,
      cmd: (matched[5] ?? "").trim()
    });
  }
  return out;
}

/**
 * 网络采集脚本：ss 输出全部 TCP/UDP 套接字及进程归属；
 * `-H` 去表头。ponytail: 只认 ss（主流 Linux 自带），
 * 极老机器没有 ss 时需回退 netstat，目前不预置。
 */
export const NET_SCRIPT =
  "ss -tunapH 2>/dev/null";

export type NetInfo = {
  pid: number;
  name: string;
  ip: string;
  port: string;
  /** 该本地地址上不同远端 IP 数 */
  ipCount: number;
  /** 该本地地址上的已建立连接数（不含监听行本身） */
  connCount: number;
  /** 接收队列字节合计 */
  recv: number;
  /** 发送队列字节合计 */
  send: number;
};

/** `127.0.0.1:40475` / `[::]:8888` → { ip, port }。 */
function splitAddr(addr: string): {
  ip: string;
  port: string;
} {
  if (addr.startsWith("[")) {
    const end = addr.indexOf("]");
    return {
      ip: addr.slice(0, end + 1),
      port: addr.slice(end + 2)
    };
  }
  const idx = addr.lastIndexOf(":");
  return {
    ip: idx < 0 ? addr : addr.slice(0, idx),
    port: idx < 0 ? "" : addr.slice(idx + 1)
  };
}

/**
 * 解析 ss 输出：按 (协议, 本地地址) 聚合成一行 ——
 * 监听 socket 与打到同一端口的连接合并统计连接数 / 远端 IP 数 / 队列。
 */
export function parseNetInfo(
  stdout: string
): NetInfo[] {
  type Group = {
    proto: string;
    ip: string;
    port: string;
    pid: number;
    name: string;
    conns: number;
    peers: Set<string>;
    recv: number;
    send: number;
  };
  const groups = new Map<string, Group>();
  for (const line of stdout.split("\n")) {
    const matched =
      /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(
        line.trim()
      );
    if (!matched) continue;
    const [
      ,
      proto,
      state,
      recvq,
      sendq,
      local,
      peer,
      rest
    ] = matched;
    const { ip, port } = splitAddr(local ?? "");
    const proc = /\("(.+?)"[^)]*?pid=(\d+)/.exec(
      rest ?? ""
    );
    // 键用 协议+端口：IPv6 监听 [::]:8885 与 v4-mapped 连接
    // [::ffff:x.x.x.x]:8885 是同一个服务，必须合并到一行（见函数注释）
    const key = `${proto}|${port}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        proto: proto ?? "",
        ip,
        port,
        pid: Number(proc?.[2]) || 0,
        name: proc?.[1] ?? "-",
        conns: 0,
        peers: new Set(),
        recv: 0,
        send: 0
      };
      groups.set(key, group);
    }
    if (
      state !== "LISTEN" &&
      state !== "UNCONN"
    ) {
      // 队列只统计连接行：监听 socket 的 sendq/recvq 是 accept
      // backlog（如 0/128），加进来只会污染速率与队列展示
      group.recv += Number(recvq) || 0;
      group.send += Number(sendq) || 0;
      group.conns += 1;
      const peerIp = splitAddr(peer ?? "").ip;
      if (peerIp && peerIp !== "*")
        group.peers.add(peerIp);
    }
  }
  return [...groups.values()].map(g => ({
    pid: g.pid,
    name: g.name,
    ip: g.ip,
    port: g.port,
    ipCount: g.peers.size,
    connCount: g.conns,
    recv: g.recv,
    send: g.send
  }));
}

/**
 * 状态栏采集脚本：负载 + 运行时长 + 两次 /proc/net/dev 采样求速率。
 * 间隔 1s，整体约 1.2s 返回，供状态栏低频轮询。
 */
export const STATUS_SCRIPT = `echo ===L===
cat /proc/loadavg
echo ===U===
cut -d" " -f1 /proc/uptime
echo ===N1===
cat /proc/net/dev
sleep 1
echo ===N2===
cat /proc/net/dev`;

export type StatusSample = {
  load: string;
  uptimeSec: number;
  rxBps: number;
  txBps: number;
};

function markerSection(
  stdout: string,
  mark: string
): string[] {
  // indexOf 切段，避免模板字符串里正则转义的双层反斜杠坑
  const begin = `===${mark}===\n`;
  const start = stdout.indexOf(begin);
  if (start < 0) return [];
  const body = stdout.slice(start + begin.length);
  const end = body.indexOf("\n===");
  return (
    end < 0 ? body : body.slice(0, end)
  ).split("\n");
}

/** /proc/net/dev 行内合计所有网卡（除 lo）的收发字节。 */
function netTotals(lines: string[]): {
  rx: number;
  tx: number;
} {
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const parts = line
      .split(/[:\s]+/)
      .filter(Boolean);
    if (
      parts.length < 10 ||
      parts[0] === "lo" ||
      parts[0] === "Inter" ||
      parts[0] === "face"
    )
      continue;
    rx += Number(parts[1]) || 0;
    tx += Number(parts[9]) || 0;
  }
  return { rx, tx };
}

/** 解析状态栏采样；缺段给零值不抛错。 */
export function parseStatusSample(
  stdout: string
): StatusSample {
  const load = markerSection(stdout, "L")[0]
    ?.trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" / ");
  const uptimeSec =
    Number(
      markerSection(stdout, "U")[0]
        ?.trim()
        .split(/\s+/)[0]
    ) || 0;
  const n1 = netTotals(
    markerSection(stdout, "N1")
  );
  const n2 = netTotals(
    markerSection(stdout, "N2")
  );
  return {
    load: load ?? "",
    uptimeSec,
    rxBps: Math.max(0, n2.rx - n1.rx),
    txBps: Math.max(0, n2.tx - n1.tx)
  };
}

/** 速率紧凑格式：5K / 1.2M（状态栏空间小，不要 "5.0 KB"）。 */
export function fmtShort(bytes: number): string {
  if (bytes < 1024)
    return `${Math.round(bytes)}B`;
  const units = ["K", "M", "G", "T"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const text =
    value >= 100
      ? String(Math.round(value))
      : value.toFixed(1).replace(/\.0$/, "");
  return `${text}${units[i]}`;
}
