import {
  useCallback,
  useRef,
  useState
} from "react";
import {
  KeyOutlined,
  ReloadOutlined,
  UndoOutlined
} from "@ant-design/icons";
import {
  ACTION_LABELS,
  APP_SHORTCUTS as DEFAULT_SHORTCUTS,
  beginShortcutRecording,
  chordFromEvent,
  findConflict,
  useShortcuts,
  type ShortcutOverrides
} from "@/shared/lib/appShortcuts";
import {
  useT,
  type MessageKey,
  type Translator
} from "@/settings/lib/i18n";

type Props = {
  /** 当前生效的覆盖（只含与默认不同的）。变更由父组件落盘。 */
  overrides: ShortcutOverrides;
  onChange: (next: ShortcutOverrides) => void;
};

/**
 * 设置页要列出的全部动作（**单层，不分组**）。
 *
 * 顺序 = `APP_SHORTCUTS` 的声明顺序（会话操作 → 编辑 → 查找 → 工具 →
 * 终端上下文），用户在这一页看到的排列与「应用菜单里从上到下会遇到的
 * 顺序」一致，找东西时不用记分组。
 *
 * ⚠️ 曾经用 `ACTION_GROUPS`（文件 / 编辑 / 查看 / 工具 / 终端右键菜单）
 * 分五段渲染，用户要求取消分版块。分组数据本身仍在 appShortcuts 里
 * （i18n 与别处可能还要按分组取名字），只是这一页不再按它渲染。
 */
const ALL_SHORTCUT_ACTIONS: string[] =
  Object.keys(DEFAULT_SHORTCUTS);

/**
 * 快捷键编辑区：按分组列出全部动作，点一下开始录制。
 *
 * 交互照抄 VS Code 的「键盘快捷方式」页：点格子 → 变「按下组合键」→
 * 用户按 → 直接写入。唯一的额外约束是**撞车提示**（在这里就要说清，
 * 不能等到存完发现另一个动作抢了同一个键）。
 *
 * ⚠️ **录制期间必须让全局按键处理让路**（`beginShortcutRecording`）：
 * 用户在这页按 Ctrl+Shift+N，AppHeader 的捕获监听会先一步把它当
 * 「新建会话」执行掉，键位就录不进去了。
 */
export default function ShortcutSettings({
  overrides,
  onChange
}: Props) {
  const t = useT();
  const shortcuts = useShortcuts();
  /** 正在录制的动作 id；null 表示没有在录制 */
  const [recording, setRecording] = useState<
    string | null
  >(null);
  /** 冲突提示：`动作 id → 提示文案` */
  const [conflict, setConflict] = useState<{
    actionId: string;
    message: string;
  } | null>(null);
  /**
   * 录制时临时挂到 window 上的监听器清理函数。
   *
   * 存在 ref 里是为了 `cancel` / `save` 两条路径都能拿到同一个 release，
   * 且卸载时兜底清理 —— 漏了会让全局按键处理永久停在「让路」状态，
   * 之后所有快捷键都失灵。
   */
  const releaseRef = useRef<(() => void) | null>(
    null
  );

  const stopRecording = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
    setRecording(null);
  }, []);

  /**
   * 写入一个动作的新键位。
   *
   * 与默认相同则**删掉该条**而不是存成同样的值：只留差异，
   * 以后调整默认键位时没主动设过的用户会自动跟随。
   */
  const apply = useCallback(
    (actionId: string, chord: string) => {
      const next: ShortcutOverrides = {
        ...overrides
      };
      if (
        (shortcutOfDefault(actionId) ?? "") ===
        chord
      )
        delete next[actionId];
      else next[actionId] = chord;
      onChange(next);
    },
    [overrides, onChange]
  );

  const startRecording = useCallback(
    (actionId: string) => {
      setConflict(null);
      stopRecording();
      setRecording(actionId);
      const release = beginShortcutRecording();
      releaseRef.current = release;
      const onKeyDown = (
        event: KeyboardEvent
      ) => {
        // Esc 取消录制：用户多半是点错了想退出
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          stopRecording();
          return;
        }
        const chord = chordFromEvent(event);
        // 裸字母/单按修饰键不构成组合，等用户继续按
        if (!chord) return;
        event.preventDefault();
        event.stopPropagation();
        const taken = findConflict(
          chord,
          actionId
        );
        stopRecording();
        if (taken) {
          setConflict({
            actionId,
            message: t("shortcuts.conflict", {
              name: labelOf(taken, t)
            })
          });
          return;
        }
        setConflict(null);
        apply(actionId, chord);
      };
      // 捕获阶段 + stopPropagation：录制的那一下只进这里，
      // 不再往下传到 xterm（终端里按 Ctrl+V 会真的粘进来一段文字）
      window.addEventListener(
        "keydown",
        onKeyDown,
        true
      );
      // 录完（或取消）摘掉监听
      releaseRef.current = (() => {
        release();
        window.removeEventListener(
          "keydown",
          onKeyDown,
          true
        );
        releaseRef.current = null;
      }) as () => void;
    },
    [apply, stopRecording, t]
  );

  /** 恢复单个动作的默认键位。 */
  const resetOne = useCallback(
    (actionId: string) => {
      const next = {
        ...overrides
      };
      delete next[actionId];
      onChange(next);
      setConflict(null);
    },
    [overrides, onChange]
  );

  const customizedCount =
    Object.keys(overrides).length;

  return (
    <div className="shortcut-settings">
      <p className="shortcut-hint">
        {t("shortcuts.hint")}
      </p>
      {/* ⚠️ **单层列表，不分组**：原先按「文件 / 编辑 / 查看 / 工具 /
          终端右键菜单」分五段，每段一个标题。用户要求取消分版块 ——
          五个小标题把 16 行切碎，找一个动作要先判断它在哪个版块，
          比平铺扫一遍更慢。 */}
      <div className="shortcut-list">
        {ALL_SHORTCUT_ACTIONS.map(actionId => {
          const chord = shortcuts[actionId] ?? "";
          const isCustomized =
            overrides[actionId] !== undefined;
          const isRecordingThis =
            recording === actionId;
          return (
            <div
              key={actionId}
              className="shortcut-item"
            >
              <div className="shortcut-name">
                <span className="shortcut-label">
                  {labelOf(actionId, t)}
                </span>
                {isCustomized && (
                  <span className="shortcut-custom">
                    {t("shortcuts.custom")}
                  </span>
                )}
              </div>
              <div className="shortcut-actions">
                <button
                  type="button"
                  className={
                    isRecordingThis
                      ? "shortcut-key is-recording"
                      : "shortcut-key"
                  }
                  aria-label={t(
                    "shortcuts.record"
                  )}
                  // 点击后进入录制态：这一下不能再触发全局动作
                  onClick={() =>
                    startRecording(actionId)
                  }
                >
                  {isRecordingThis ? (
                    <span className="shortcut-recording">
                      {t("shortcuts.listening")}
                    </span>
                  ) : (
                    <KeyOutlined />
                  )}
                  {!isRecordingThis && chord}
                </button>
                <button
                  type="button"
                  className="shortcut-reset"
                  aria-label={t(
                    "shortcuts.resetOne"
                  )}
                  // 已经是默认值就没得重置，禁用省得给假反馈
                  disabled={!isCustomized}
                  onClick={() =>
                    resetOne(actionId)
                  }
                >
                  <UndoOutlined />
                </button>
              </div>
              {conflict?.actionId ===
                actionId && (
                <p className="shortcut-conflict">
                  {conflict.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="shortcut-footer">
        <button
          type="button"
          className="shortcut-reset-all"
          disabled={customizedCount === 0}
          onClick={() => {
            onChange({});
            setConflict(null);
            stopRecording();
          }}
        >
          <ReloadOutlined />
          {t("shortcuts.resetAll")}
        </button>
        {customizedCount > 0 && (
          <span className="shortcut-count">
            {t("shortcuts.customizedCount", {
              count: customizedCount
            })}
          </span>
        )}
      </div>
    </div>
  );
}

/** 取动作的默认键位（与 overrides 无关，用于「是否恢复过」的比较）。 */
function shortcutOfDefault(
  actionId: string
): string | undefined {
  return DEFAULT_SHORTCUTS[actionId];
}

/**
 * 动作 id → i18n 键。
 *
 * ⚠️ 必须显式列全，不能用模板字符串拼键：`Translator` 的 key 是
 * `MessageKey` 联合类型，`shortcuts.action.${id}` 拼出来的是 `string`，
 * tsc 直接报错。顺带这份表也能当成「哪些动作该有文案」的清单。
 */
const ACTION_I18N_KEYS: Record<
  string,
  MessageKey
> = {
  newSession: "app.menu.newSsh",
  openLocal: "app.menu.openLocal",
  exportSessions: "transfer.export",
  importSessions: "transfer.import",
  closeActive: "app.menu.closeActive",
  quit: "app.menu.quit",
  copy: "app.action.copy",
  paste: "app.action.paste",
  selectAll: "app.action.selectAll",
  clear: "app.action.clear",
  find: "app.menu.find",
  toggleMaximize: "app.menu.maximize",
  openSftp: "app.action.openSftp",
  devtools: "app.action.devtools",
  reconnect: "terminal.reconnect.action",
  toggleFocusMode: "terminal.fullscreen.action"
};

/** 动作的展示名：复用应用菜单里已有的文案，缺键退回英文。 */
function labelOf(
  actionId: string,
  t: Translator
): string {
  const key = ACTION_I18N_KEYS[actionId];
  if (key) return t(key);
  return ACTION_LABELS[actionId] ?? actionId;
}
