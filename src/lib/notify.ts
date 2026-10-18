/**
 * 系统通知：长命令跑完、AI 回答完成、传输结束。
 *
 * ## 为什么只在窗口未聚焦时通知
 *
 * 这是通知类功能的核心取舍：你**正看着终端**时弹通知等于干扰，而这
 * 恰恰是用户最不需要提醒的时刻；切换出去忘了回来时，它才真正有用。
 * 代价是「守着看」就收不到 —— 但那种情况下用户本来就知道结果。
 *
 * ## 为什么长命令用「静默判定」而不是 shell 集成
 *
 * 精确的命令边界需要 OSC 133（shell integration），代价是用户得在
 * bash/zsh 里 source 一段脚本、改 `.bashrc`。本项目是 SSH 客户端，
 * 远端环境千差万别，为一个通知功能要求用户改 shell 配置不划算。
 *
 * 折中：按回车开始计时，之后**终端静默一段时间视为命令结束**。
 * 绝大多数命令（编译、npm install、git clone）跑完后会立刻吐出提示符，
 * 静默判定与真实边界几乎一致；少数会静默等待输入的命令
 * （如 `less`、确认提示）会提前判结束 —— 代价只是通知早了几秒，
 * 而提前通知总比漏通知好。
 */

/** 通知类别。 */
export type NotifyKind =
  "command" | "ai" | "transfer";

/** 一条待发通知。 */
export type NotifyPayload = {
  kind: NotifyKind;
  title: string;
  body: string;
};

/** 各类通知的耗时阈值（毫秒），以及命令静默判定窗口。 */

/**
 * 终端静默多久算「命令结束」。
 *
 * 取 1.5 秒：远端提示符绘制基本是即时的，1.5 秒足以让「输出完了、
 * 正在打提示符」这段完成；而再长会让 `npm install` 这类命令的通知
 * 明显滞后，用户会觉得「卡了一下才响」。
 */
export const SILENCE_WINDOW_MS = 1500;

/**
 * 命令耗时达到多少才通知（毫秒）。
 *
 * 默认 5 秒：短于这个的 `ls`、`git status` 弹通知纯属噪音。
 */
export const COMMAND_THRESHOLD_MS = 5000;

/** 把毫秒格式化成「1分23秒」这种人类可读的形式。 */
export function formatDuration(
  ms: number
): string {
  if (!Number.isFinite(ms) || ms < 0)
    return "0 秒";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60)
    return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  // 整分时不带秒位：「2 分」比「2 分 0 秒」干净
  return seconds === 0
    ? `${minutes} 分`
    : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 该不该为这次完成事件发通知。
 *
 * 三道闸门缺一不可：功能开关打开 → 本类事件开着 → 窗口确实没聚焦。
 * 抽成纯函数是为了能单测 —— 这三条任何一条写反了，症状都是
 * 「通知乱弹」或「永远不弹」，只能靠断言钉住。
 *
 * @param options.enabled 全局总开关
 * @param options.kindEnabled 该类事件的开关
 * @param options.focused 主窗口当前是否聚焦
 * @param options.elapsedMs 本次耗时；命令类据此比对阈值
 * @param options.thresholdMs 阈值（毫秒），仅命令类有效
 */
export function shouldNotify(options: {
  enabled: boolean;
  kindEnabled: boolean;
  focused: boolean;
  /** 传 undefined 表示不参与耗时判定（AI / 传输类） */
  elapsedMs?: number;
  thresholdMs?: number;
}): boolean {
  if (!options.enabled) return false;
  if (!options.kindEnabled) return false;
  // 正在看着就别打扰
  if (options.focused) return false;
  if (
    options.elapsedMs !== undefined &&
    options.thresholdMs !== undefined &&
    options.elapsedMs < options.thresholdMs
  )
    return false;
  return true;
}

/**
 * 命令计时器：把「按回车 → 输出流 → 静默」这套时序收敛到一处。
 *
 * 之所以不用 xterm 的 onData 直接判断，是因为「用户敲完命令」与
 * 「终端开始输出」之间可能隔很久（网络慢、远端卡），中间不该被
 * 判成结束。显式地由调用方告诉它命令开始了，才不会误报。
 *
 * ## 为什么「没输出过的命令」永不判定结束
 *
 * 静默判定有个绕不开的盲区：命令在跑、但**一个字符都不吐**
 * （`sleep 60`、等待输入的脚本），此时终端是静的。若照样判定结束，
 * 就会在 1.5 秒后弹出「命令已完成 · 2 秒」—— 而命令明明还在跑。
 *
 * 这种**假阳性比漏通知糟得多**：用户看到提醒会以为命令真跑完了，
 * 于是回来看结果，发现还在跑，此前所有通知的可信度一起崩掉。
 *
 * 而真正值得提醒的长命令（编译、npm install、git clone、wget）
 * 几乎必然有输出。所以加一条「必须先有输出」的门槛：
 * 既消除了假阳性，也不需要把静默窗口拉长到几秒去赌。
 */
export class CommandTimer {
  private startedAt = 0;
  private silenceHandle: ReturnType<
    typeof setTimeout
  > | null = null;
  private running = false;
  /** 本次命令是否吐过东西；没吐过就不判定结束（见类注释） */
  private sawOutput = false;

  constructor(
    private readonly onFinish: (
      elapsedMs: number
    ) => void,
    private readonly silenceMs = SILENCE_WINDOW_MS
  ) {}

  /** 当前是否在监控一个命令。 */
  get active(): boolean {
    return this.running;
  }

  /**
   * 命令开始（用户在终端里按了回车）。
   *
   * 连续调用会重新计时 —— 连着敲多条命令时，只有最后一条的耗时
   * 值得关注，前面几条早该弹过了。
   */
  start(): void {
    this.cancelSilence();
    this.startedAt = Date.now();
    this.running = true;
    this.sawOutput = false;
    // 计时起点也留痕：若终端里始终没看到 finish 的日志，
    // 就能确定问题在「命令提交 → 计时」这一段，而非后续的通知判定
    console.debug(
      "[notify] 开始计时（等待终端输出）"
    );
  }

  /**
   * 终端有输出：把静默计时往后推。
   *
   * 大数据量输出时这个函数会被调几万次，所以里面只做一次
   * clearTimeout/setTimeout，没有别的开销。
   */
  poke(): void {
    if (!this.running) return;
    // 第一次输出才开排：此前无论静默多久都不该判定结束
    if (this.sawOutput) this.cancelSilence();
    this.sawOutput = true;
    this.silenceHandle = setTimeout(
      this.finish,
      this.silenceMs
    );
  }

  /** 终止监控（切换会话、关闭终端时调用），不触发回调。 */
  abort(): void {
    this.cancelSilence();
    this.running = false;
    this.startedAt = 0;
    this.sawOutput = false;
  }

  private finish = (): void => {
    this.silenceHandle = null;
    if (!this.running) return;
    this.running = false;
    const elapsed = Date.now() - this.startedAt;
    this.startedAt = 0;
    // 从未吐过字符 → 命令可能只是安静地在跑，不判定结束
    if (!this.sawOutput) {
      console.debug(
        `[notify] 静默结束但无输出，不通知（${elapsed}ms）`
      );
      return;
    }
    this.sawOutput = false;
    console.debug(
      `[notify] 命令结束（${elapsed}ms）`
    );
    this.onFinish(elapsed);
  };

  private cancelSilence(): void {
    if (this.silenceHandle !== null) {
      clearTimeout(this.silenceHandle);
      this.silenceHandle = null;
    }
  }
}
