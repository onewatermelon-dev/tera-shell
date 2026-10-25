import { describe, it, expect } from "vitest";
import {
  assertReadOnly,
  buildWatchScript,
  checkValue,
  cpuUsageOf,
  isBreach,
  parseDf,
  parseWatchSample
} from "@/watch/lib/watchChecks";
import {
  makeCheck,
  type WatchCheck
} from "@/watch/lib/watchTypes";

/**
 * 巡检采集：脚本生成 + 输出解析。
 *
 * 这两件事错在哪都「看不出来」：
 * - 脚本少拼一段 → 指标恒为 null，判定全部跳过，表现为「永远正常」；
 * - 解析错位 → 把 `df` 的 Used 当使用率（85 变成 51200），或者退出码
 *   永远是 0，自定义检查项形同虚设。
 */

/** 一条完整的采集输出（各分节按真实脚本的格式）。 */
const STDOUT = [
  "===W:STAT1===",
  "cpu  100 0 100 800 0 0 0 0",
  "===W:MEM===",
  "MemTotal:        1000 kB",
  "MemAvailable:     400 kB",
  "===W:LOAD===",
  "1.50 1.00 0.50",
  "4",
  "===W:DF===",
  "Filesystem     1024-blocks      Used Available Capacity Mounted on",
  "/dev/sda1         102400     51200     51200      50% /",
  "/dev/sdb1        1024000    921600    102400      90% /data",
  "===W:SVC===",
  "nginx active",
  "redis failed",
  "===W:CMD===",
  "everything is fine",
  "===W:EXIT===",
  "0",
  "===W:STAT2===",
  "cpu  150 0 150 900 0 0 0 0"
].join("\n");

describe("采集脚本的拼装", () => {
  it("只拼启用的检查项", () => {
    const script = buildWatchScript([
      { ...makeCheck("cpu"), enabled: true },
      makeCheck("disk")
    ]);
    expect(script).toContain("===W:STAT1===");
    expect(script).toContain("===W:STAT2===");
    // 磁盘没启用 → 不该出现 df
    expect(script).not.toContain("df -P");
  });

  it("CPU 两次采样之间必须隔一次 sleep", () => {
    const script = buildWatchScript([
      { ...makeCheck("cpu"), enabled: true }
    ]);
    expect(script.indexOf("STAT1")).toBeLessThan(
      script.indexOf("sleep 1")
    );
    expect(
      script.indexOf("sleep 1")
    ).toBeLessThan(script.indexOf("STAT2"));
  });

  it("服务单元名会被单引号包裹", () => {
    const script = buildWatchScript([
      {
        ...makeCheck("service"),
        enabled: true,
        unit: "nginx"
      }
    ]);
    expect(script).toContain(
      "systemctl is-active 'nginx'"
    );
  });

  it("含特殊字符的单元名不会被拼进脚本（宁可空转也不破坏结构）", () => {
    const script = buildWatchScript([
      {
        ...makeCheck("service"),
        enabled: true,
        unit: "we'ird;rm -rf /"
      }
    ]);
    expect(script).not.toContain("we'ird");
    // 整段 SVC 分节都不会生成
    expect(script).not.toContain("===W:SVC===");
  });

  it("自定义命令先存退出码再输出，别被 echo 覆盖", () => {
    const script = buildWatchScript([
      {
        ...makeCheck("command"),
        enabled: true,
        command: "uptime"
      }
    ]);
    expect(script).toContain("__w_code=$?");
    expect(script).not.toContain(
      'echo "===W:EXIT===$?"'
    );
  });
});

describe("只读守卫", () => {
  it("放行常见的只读命令", () => {
    for (const command of [
      "df -P",
      "uptime",
      "cat /proc/loadavg",
      "systemctl is-active nginx",
      "ps aux | grep nginx"
    ])
      expect(assertReadOnly(command)).toBeNull();
  });

  it("拦下写操作", () => {
    for (const command of [
      "rm -rf /tmp/x",
      "systemctl restart nginx",
      "dd if=/dev/zero of=/dev/sda",
      "echo 1 > /proc/sys/x",
      "apt-get upgrade"
    ])
      expect(
        assertReadOnly(command)
      ).not.toBeNull();
  });

  it("空命令直接拒绝", () => {
    expect(assertReadOnly("   ")).not.toBeNull();
  });
});

describe("输出解析", () => {
  const sample = parseWatchSample(
    STDOUT,
    1_700_000_000_000
  );

  it("CPU 用两次 /proc/stat 的差值算，且 iowait 算空闲", () => {
    // 差值：50/0/50/100/0...，总 200，idle=100 → 占用 50%
    expect(sample.cpu).toBeCloseTo(50, 5);
    expect(
      cpuUsageOf(
        [100, 0, 0, 100],
        [200, 0, 0, 200]
      )
    ).toBeCloseTo(50, 5);
  });

  it("内存用 MemAvailable 而不是 MemFree", () => {
    // (1000-400)/1000 = 60%
    expect(sample.mem).toBeCloseTo(60, 5);
  });

  it("负载归一化成每核", () => {
    expect(sample.cores).toBe(4);
    expect(sample.load).toBeCloseTo(0.375, 5);
  });

  it("磁盘按挂载点取使用率", () => {
    expect(sample.disks["/"]).toBe(50);
    expect(sample.disks["/data"]).toBe(90);
  });

  it("服务状态按单元名落表", () => {
    expect(sample.services.nginx).toBe("active");
    expect(sample.services.redis).toBe("failed");
  });

  it("自定义命令的输出与退出码都拿得到", () => {
    expect(sample.commandOutput).toBe(
      "everything is fine"
    );
    expect(sample.commandExit).toBe(0);
  });

  it("缺分节时给 null / 空表，不抛错", () => {
    const empty = parseWatchSample("", 1);
    expect(empty.cpu).toBeNull();
    expect(empty.mem).toBeNull();
    expect(empty.load).toBeNull();
    expect(empty.disks).toEqual({});
  });

  it("df 表头不会被当成数据", () => {
    expect(
      parseDf([
        "Filesystem 1024-blocks Used Available Capacity Mounted on",
        "/dev/sda1 100 50 50 50% /"
      ])
    ).toEqual({ "/": 50 });
  });
});

describe("取值与越界判断", () => {
  const sample = parseWatchSample(STDOUT, 1);

  function disk(mount: string): WatchCheck {
    return {
      ...makeCheck("disk"),
      enabled: true,
      threshold: 85,
      mount
    };
  }

  it("磁盘按挂载点取值", () => {
    expect(checkValue(disk("/"), sample)).toBe(
      50
    );
    expect(
      checkValue(disk("/data"), sample)
    ).toBe(90);
  });

  it("没配的挂载点返回 null（不参与判定）", () => {
    expect(
      checkValue(disk("/nope"), sample)
    ).toBeNull();
  });

  it("服务活着是 1，挂了是 0，状态未知是 null", () => {
    const unit = (name: string): WatchCheck => ({
      ...makeCheck("service"),
      enabled: true,
      unit: name
    });
    expect(
      checkValue(unit("nginx"), sample)
    ).toBe(1);
    expect(
      checkValue(unit("redis"), sample)
    ).toBe(0);
    expect(
      checkValue(unit("ghost"), sample)
    ).toBeNull();
  });

  it("百分比类阈值是「大于」，服务类是「不等于活着」", () => {
    expect(isBreach(disk("/"), 90)).toBe(true);
    expect(isBreach(disk("/"), 50)).toBe(false);
    const service: WatchCheck = {
      ...makeCheck("service"),
      enabled: true,
      unit: "redis"
    };
    expect(isBreach(service, 0)).toBe(true);
    expect(isBreach(service, 1)).toBe(false);
  });
});
