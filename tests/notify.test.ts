import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach
} from "vitest";
import {
  CommandTimer,
  COMMAND_THRESHOLD_MS,
  formatDuration,
  shouldNotify,
  SILENCE_WINDOW_MS
} from "@/lib/notify";

/**
 * 系统通知的判定与计时。
 *
 * 这些是通知系统里最容易「写反了但看不出来」的部分：
 * - 条件反了 → 用户正看着终端时被通知糊脸，或者永远收不到通知；
 * - 计时反了 → 每敲一次回车就弹一个通知。
 *
 * 而这些症状在开发时极难复现（要真的切窗口、真的敲命令），
 * 所以全部钉成断言。
 */
describe("该不该发通知", () => {
  const base = {
    enabled: true,
    kindEnabled: true,
    focused: false
  };

  it("四道条件全满足才发", () => {
    expect(shouldNotify(base)).toBe(true);
  });

  it("总开关关着 → 不发", () => {
    expect(
      shouldNotify({ ...base, enabled: false })
    ).toBe(false);
  });

  it("分类开关关着 → 不发", () => {
    expect(
      shouldNotify({
        ...base,
        kindEnabled: false
      })
    ).toBe(false);
  });

  it("⚠️ 窗口正聚焦 → 不发", () => {
    // 这是本功能的核心取舍：守着看的时候不该被打扰。
    // 写反了就是「正看着终端还被通知」，用户会直接关掉这个功能
    expect(
      shouldNotify({
        ...base,
        focused: true
      })
    ).toBe(false);
  });

  it("⚠️ focused 的语义是「窗口当前是否聚焦」，不是「是否该拦截」", () => {
    // 回归测试（2026-10-18 实际 bug）：调用处曾写成
    // `shouldNotify({ ...criteria, focused: !isFocused })` —— 多取反了一次，
    // 整个行为颠倒：正盯着窗口反而弹通知、切走了反而不弹。
    // 现象是「明明四项都合格却被拦」，且日志显示的状态与实际传进去的
    // 不一致（日志打未聚焦、判定收到聚焦），两个数字对不上。
    //
    // 这里的断言把语义钉死：调用方**直接传**窗口状态，不做任何取反。
    const cases = [
      { focused: false, expected: true },
      { focused: true, expected: false }
    ];
    for (const item of cases) {
      expect(
        shouldNotify({
          enabled: true,
          kindEnabled: true,
          focused: item.focused
        })
      ).toBe(item.expected);
    }
  });

  it("命令类比对耗时阈值", () => {
    const withTime = {
      ...base,
      thresholdMs: COMMAND_THRESHOLD_MS
    };
    // 恰好等于阈值：发（>= 而非 >，否则用户设的 5 秒实际是 6 秒）
    expect(
      shouldNotify({
        ...withTime,
        elapsedMs: COMMAND_THRESHOLD_MS
      })
    ).toBe(true);
    expect(
      shouldNotify({
        ...withTime,
        elapsedMs: COMMAND_THRESHOLD_MS - 1
      })
    ).toBe(false);
  });

  it("不传耗时不参与阈值判定（AI / 传输类）", () => {
    expect(
      shouldNotify({
        ...base,
        elapsedMs: undefined,
        thresholdMs: undefined
      })
    ).toBe(true);
  });
});

describe("耗时格式化", () => {
  it("秒级直接显示", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(1500)).toBe("2 秒");
    expect(formatDuration(59000)).toBe("59 秒");
  });

  it("超过一分钟带分位", () => {
    expect(formatDuration(60000)).toBe("1 分");
    expect(formatDuration(83000)).toBe(
      "1 分 23 秒"
    );
  });

  it("非法输入不抛异常", () => {
    expect(formatDuration(-1)).toBe("0 秒");
    expect(formatDuration(Number.NaN)).toBe(
      "0 秒"
    );
  });
});

describe("长命令计时器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("命令提交 → 有输出 → 静默一个窗口后回调，回报耗时", () => {
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.start();
    // 命令跑了 3 秒，期间断断续续有输出
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(500);
      timer.poke();
    }
    // 静默窗口到了 → 判为结束
    vi.advanceTimersByTime(SILENCE_WINDOW_MS);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toBeGreaterThanOrEqual(
      3000 + SILENCE_WINDOW_MS
    );
  });

  it("⚠️ 没吐过字符的命令永不判定结束", () => {
    // `sleep 60` 这类命令跑着但不输出，终端是静的。若照样判定结束，
    // 会弹出「命令已完成 · 2 秒」而命令明明还在跑 —— 假阳性一旦出现，
    // 用户对所有通知的信任就一起崩了
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.start();
    vi.advanceTimersByTime(60000);
    expect(finished).toHaveLength(0);
    // 但它仍在监控着
    expect(timer.active).toBe(true);
  });

  it("先静默、后有输出，也能正确判定", () => {
    // 命令启动到第一个字节之间可能隔很久（网络慢），
    // 这段静默不该被算成「结束」
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.start();
    vi.advanceTimersByTime(4000);
    expect(finished).toHaveLength(0);
    timer.poke();
    vi.advanceTimersByTime(SILENCE_WINDOW_MS);
    expect(finished).toHaveLength(1);
  });

  it("输出会不断推迟判定，不会提前结束", () => {
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.start();
    // 大数据量输出：每 800ms 来一次，持续 5 秒
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(800);
      timer.poke();
    }
    expect(finished).toHaveLength(0);
    // 输出停了才结束
    vi.advanceTimersByTime(SILENCE_WINDOW_MS);
    expect(finished).toHaveLength(1);
  });

  it("没有命令在跑时 poke 不触发任何回调", () => {
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.poke();
    vi.advanceTimersByTime(10000);
    expect(finished).toHaveLength(0);
  });

  it("abort 后不触发回调（切换会话/关闭终端）", () => {
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.start();
    timer.abort();
    vi.advanceTimersByTime(10000);
    expect(finished).toHaveLength(0);
    expect(timer.active).toBe(false);
  });

  it("⚠️ 连敲多条命令只通知最后一条", () => {
    const finished: number[] = [];
    const timer = new CommandTimer(ms =>
      finished.push(ms)
    );
    timer.start();
    vi.advanceTimersByTime(1000);
    timer.poke();
    vi.advanceTimersByTime(1000);
    // 又敲了一条：重新计时
    timer.start();
    vi.advanceTimersByTime(500);
    timer.poke();
    vi.advanceTimersByTime(SILENCE_WINDOW_MS);
    // 只应有一次回调，且报的是第二条命令的耗时（约 2 秒而非 4 秒）
    expect(finished).toHaveLength(1);
    expect(finished[0]).toBeLessThan(3000);
  });

  it("active 反映当前是否在监控", () => {
    const timer = new CommandTimer(() => {});
    expect(timer.active).toBe(false);
    timer.start();
    expect(timer.active).toBe(true);
    // 有输出后静默到点 → 结束
    timer.poke();
    vi.advanceTimersByTime(SILENCE_WINDOW_MS);
    expect(timer.active).toBe(false);
  });
});

/**
 * 通知提示音传的是**系统音效名**，不是文件路径。
 *
 * 插件 JSDoc 说 Windows 上支持 `.wav` 路径，是错的：WinRT toast 只认
 * `ms-winsoundevent:` 协议，给路径**不报错、只是静默不响**（2026-10-18
 * 实际踩过，为此白写了一个探测音效文件的 Rust 命令）。
 *
 * 更隐蔽的是**不传 sound 等于显式静音**（插件会写出 `<audio silent="true" />`），
 * 所以这里必须钉住"有值且是合法音效名"，而不是"可以为 undefined"。
 */
describe("通知提示音", () => {
  it("音效名必须是 WinRT 认的那几个，不能是文件路径", async () => {
    const source =
      await import("@/lib/notifySend.ts?raw").then(
        m => m.default as string
      );
    // 提取音效常量：const NOTIFY_SOUND = "XXX"
    const matched = source.match(
      /const NOTIFY_SOUND = "([^"]*)"/
    );
    expect(matched).not.toBeNull();
    // 上面已断言 matched 非空，这里用 ?? "" 兜住类型
    const sound = matched?.[1] ?? "";
    // 合法值来自 Sound::from_str：Default / IM / Mail / Reminder / SMS
    // 或 LoopableSound（Alarm / Call / ...）
    const known = [
      "Default",
      "IM",
      "Mail",
      "Reminder",
      "SMS"
    ];
    const isLoopable =
      /^(Alarm|Call|SMS|Mail|IM)([2-9]|10)?$/.test(
        sound
      );
    expect(
      known.includes(sound) || isLoopable
    ).toBe(true);
    // 关键断言：不能是文件路径
    expect(sound).not.toMatch(
      /\.(wav|mp3|ogg)$/i
    );
    expect(sound).not.toContain("\\");
  });

  it("两处发送都必须带 sound（漏掉就是显式静音）", async () => {
    const source =
      await import("@/lib/notifySend.ts?raw").then(
        m => m.default as string
      );
    const sendCalls = source.match(
      /sendNotification\(\{/g
    );
    // 主路径 + 测试通知
    expect(
      sendCalls?.length
    ).toBeGreaterThanOrEqual(2);
    const withSound =
      source.match(/sound: NOTIFY_SOUND/g) ?? [];
    expect(withSound.length).toBe(
      sendCalls?.length ?? 0
    );
  });
});
