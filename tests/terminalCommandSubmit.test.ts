import {
  describe,
  it,
  expect,
  vi,
  beforeEach
} from "vitest";

/**
 * 「命令提交 → 计时」这条链路必须真的通。
 *
 * ## 为什么要单测它
 *
 * 2026-10-18 用户实测：测试通知能弹，长命令跑完不弹，且 Console 里
 * **一条 `[notify]` 日志都没有** —— 说明 `CommandTimer.start()` 压根没被
 * 调用，即 `onCommandSubmitted` 没触发。
 *
 * 这条链路串了四层（onData → terminalInput 的回调 → CommandTimer），
 * 每一层都可能静默失效，而失效的表现只有「不通知」这一个，定位极慢。
 *
 * 这里只测**最上游那一环**：回车时回调到底有没有被调用。它挂了，
 * 后面所有判定与通知逻辑都无从谈起 —— 上游不通就别往下查。
 */

// attachTerminalInput 会 import 一串 xterm 相关模块，这里只提供它
// 在「回车取命令」这条路径上真正用到的东西；其余走不到的分支不需要
vi.mock(
  "@/terminal/lib/commandCompletion",
  () => ({
    attachCommandCompletion: vi.fn(() => ({
      pushHistory: vi.fn(),
      consumeKeydown: vi.fn(() => false),
      dispose: vi.fn()
    }))
  })
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("@/terminal/lib/ai/tools", () => ({
  aiRunCommand: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: ""
  }),
  parseCatCommand: vi.fn(() => null),
  isVimCommand: vi.fn(() => false),
  VIM_SCHEME_SETUP: ""
}));
vi.mock("@/terminal/lib/ai/protocol", () => ({
  explainCommand: vi.fn()
}));

/** 造一只刚好够用的假终端：只需要 onData 与取当前行。 */
function fakeTerminal(line = "$ npm run build") {
  const handlers: Record<
    string,
    // 不同事件回调的参数类型各不相同，统一用 any 收口：
    // 这里只驱动 onData，其余分支压根走不到
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (arg: any) => void
  > = {};
  return {
    onData: (cb: (data: string) => void) => {
      handlers.data = cb;
    },
    onKey: vi.fn(),
    onSelectionChange: vi.fn(),
    onRender: vi.fn(() => [0, 0]),
    onScroll: vi.fn(() => [0, 0]),
    onBinary: vi.fn(),
    onWriteParsed: vi.fn(),
    onLineFeed: vi.fn(),
    onCursorMove: vi.fn(),
    onTitleChange: vi.fn(),
    onBell: vi.fn(),
    onResize: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(
      () => false
    ),
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine: () => ({
          translateToString: () => line
        })
      }
    },
    registry: { registerLinkProvider: vi.fn() },
    _fire: (data: string) => handlers.data?.(data)
  };
}

const sshSession = {
  id: "s1",
  kind: "ssh",
  host: "h",
  port: 22,
  username: "u",
  password: ""
} as never;

/** 输入管线里 AI 命令要用的连接目标；这些用例只走 PTY 路径。 */
const execTarget = {
  host: "h",
  port: 22,
  username: "u",
  password: null,
  keyPath: "",
  jump: [],
  hostKeyPolicy: "accept-new" as const
};

describe("命令提交回调", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("⚠️ 回车时必须回调，且带上命令文本", async () => {
    const { attachTerminalInput } =
      await import("@/terminal/lib/session/terminalInput");
    const terminal = fakeTerminal(
      "$ npm run build"
    );
    const submitted: string[] = [];
    attachTerminalInput(
      terminal as never,
      sshSession,
      {
        onError: vi.fn(),
        execTarget,
        commandCompletion: false,
        isDisconnected: () => false,
        onCommandSubmitted: command =>
          submitted.push(command)
      }
    );
    terminal._fire("\r");
    // 回调被调用 = 计时器会启动 = 后面才有可能通知
    expect(submitted).toEqual(["npm run build"]);
  });

  it("⚠️ 回车瞬间取不到命令文本时，仍必须触发（真实 SSH 场景）", async () => {
    // 回归测试（2026-10-18 实际卡住的就是这条）：
    // 按键先经 PTY 发给远端，远端回显之后命令才出现在 xterm 缓冲区。
    // 所以 onData 触发的那一瞬间 `buffer.getLine()` 常常还是空的
    // → stripPrompt 返回空 → command 为 null。
    // 曾写成 `if (command) onCommandSubmitted(...)`，于是计时压根不启动，
    // 长命令永远不通知，且 Console 里一条日志都没有。
    //
    // 计时起点是「按了回车」，与能否取到文本无关。
    const { attachTerminalInput } =
      await import("@/terminal/lib/session/terminalInput");
    // 行是空的：模拟远端还没回显
    const terminal = fakeTerminal("");
    const submitted: string[] = [];
    attachTerminalInput(
      terminal as never,
      sshSession,
      {
        onError: vi.fn(),
        execTarget,
        commandCompletion: false,
        isDisconnected: () => false,
        onCommandSubmitted: c => submitted.push(c)
      }
    );
    terminal._fire("\r");
    // 触发即可，取不到文本时传空串
    expect(submitted).toEqual([""]);
  });

  it("⚠️ 普通字符不得触发命令提交", async () => {
    // 回归测试：曾经写成 `command ?? data`，而普通按键时 command 为 null，
    // 于是**每敲一个字符就启动一次计时器**。用户输入
    // `npm run build` 时计时被重置 14 次，打字过程再久也到不了通知阈值。
    const { attachTerminalInput } =
      await import("@/terminal/lib/session/terminalInput");
    const terminal = fakeTerminal();
    const submitted: string[] = [];
    attachTerminalInput(
      terminal as never,
      sshSession,
      {
        onError: vi.fn(),
        execTarget,
        commandCompletion: false,
        isDisconnected: () => false,
        onCommandSubmitted: c => submitted.push(c)
      }
    );
    // 逐字敲一个命令
    for (const key of "npm run build") {
      terminal._fire(key);
    }
    expect(submitted).toHaveLength(0);
  });

  it("空行回车也会触发计时（但无输出时不会通知）", async () => {
    // 计时起点是回车本身，因此空行回车同样算「提交了一条命令」。
    // 这没有副作用：无输出的命令过不了静默判定，永远不会弹通知
    const { attachTerminalInput } =
      await import("@/terminal/lib/session/terminalInput");
    // 剥掉提示符后为空
    const terminal = fakeTerminal("$ ");
    const submitted: string[] = [];
    attachTerminalInput(
      terminal as never,
      sshSession,
      {
        onError: vi.fn(),
        execTarget,
        commandCompletion: false,
        isDisconnected: () => false,
        onCommandSubmitted: c => submitted.push(c)
      }
    );
    terminal._fire("\r");
    expect(submitted).toEqual([""]);
  });

  it("未提供回调时不报错（命令补全等其它调用方）", async () => {
    const { attachTerminalInput } =
      await import("@/terminal/lib/session/terminalInput");
    const terminal = fakeTerminal();
    expect(() =>
      attachTerminalInput(
        terminal as never,
        sshSession,
        {
          onError: vi.fn(),
          execTarget,
          commandCompletion: false,
          isDisconnected: () => false
        }
      )
    ).not.toThrow();
    expect(() =>
      terminal._fire("\r")
    ).not.toThrow();
  });

  it("断连时不触发（断连终端敲键本就无意义）", async () => {
    const { attachTerminalInput } =
      await import("@/terminal/lib/session/terminalInput");
    const terminal = fakeTerminal();
    const submitted: string[] = [];
    attachTerminalInput(
      terminal as never,
      sshSession,
      {
        onError: vi.fn(),
        execTarget,
        commandCompletion: false,
        isDisconnected: () => true,
        onCommandSubmitted: c => submitted.push(c)
      }
    );
    terminal._fire("\r");
    expect(submitted).toHaveLength(0);
  });
});
