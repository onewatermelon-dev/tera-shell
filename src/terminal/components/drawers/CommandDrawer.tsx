/**
 * 底部命令抽屉：输入命令发到终端执行，自带 VSCode 式查找替换挂件。
 *
 * 与系统/进程/网络信息抽屉共用同一块网格行轨（has-sys-drawer）与
 * 抽屉外壳样式（.sys-drawer-head/.sys-drawer-body）。
 *
 * ## 查找替换挂件（对齐 VSCode）
 *
 * - **鼠标聚焦命令框按 Ctrl+F / Ctrl+H**，输入框右上角弹出查找
 *   替换挂件（预填选中文本）；点右上角 ⌕ 图标也能开。
 * - 查找框里 **Enter/↓/↑** 在命令框中聚焦选中当前匹配（textarea
 *   只有一个选区，高亮的就是「当前这一处」）；「替换」只换当前
 *   这一处并自动跳下一处；「全部替换」一次换光；Esc / × 关闭挂件。
 * - 默认字面匹配（区分大小写），勾 `.*` 切正则（替换串支持 $1）。
 *
 * ## 发送
 *
 * 走 `terminal_write`（与快捷宏 / AI 终端执行同一条路，`command`
 * 字段带上完整命令，命令历史与日志才记得住）。默认发到活动会话，
 * 勾选后发到**所有已打开会话**（断线的自动跳过，跳过数有反馈）。
 */
import { useMemo, useRef, useState } from "react";
import {
  CloseOutlined,
  CodeOutlined,
  SearchOutlined,
  SendOutlined
} from "@ant-design/icons";
import {
  Button,
  Input,
  Surface,
  ToggleButton
} from "@heroui/react";
import Hint from "@/shared/components/Hint";
import { matchTerminalShortcut } from "@/terminal/lib/session/terminalInput";
import { useT } from "@/settings/lib/i18n";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

/** 匹配区间（字符偏移，左闭右开）。 */
type MatchRange = [number, number];

/** 匹配选项：正则 / 区分大小写 / 全字匹配（对齐 VSCode 三开关）。 */
export type FindOptions = {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
};

/** 正则元字符转义（字面查找走同一条正则管道）。 */
function escapeRegExp(source: string): string {
  return source.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/**
 * 算出全部匹配区间。正则非法时返回空（按钮另有禁用提示）。
 * 字面/全字/大小写都归一到一条正则：字面转义、全字包 \b、
 * 不区分大小写加 i 旗标——行为与 VSCode 三开关一致。
 * textarea 只有一个选区，这里给全量坐标、由调用方决定高亮哪一处。
 */
export function findMatches(
  text: string,
  find: string,
  options: FindOptions
): MatchRange[] {
  if (!find) return [];
  let source = options.regex
    ? find
    : escapeRegExp(find);
  if (options.wholeWord)
    source = String.raw`\b(?:${source})\b`;
  let re: RegExp;
  try {
    re = new RegExp(
      source,
      `g${options.caseSensitive ? "" : "i"}`
    );
  } catch {
    return [];
  }
  const ranges: MatchRange[] = [];
  for (const match of text.matchAll(re)) {
    if (match[0] === "") continue; // 零宽匹配会死循环，跳过
    ranges.push([
      match.index,
      match.index + match[0].length
    ]);
  }
  return ranges;
}

/** 正则查找串是否合法（决定替换可用性）。 */
export function isRegexValid(
  source: string
): boolean {
  if (!source) return true;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * 正则模式的替换串支持转义（VSCode 同款）：\n 换行、\t 制表、
 * \r 回车、\\ 反斜杠；未知转义原样保留。字面模式不经过这里，
 * 用户打什么就是什么。
 */
export function unescapeReplacement(
  withText: string
): string {
  return withText.replace(
    /\\(.)/g,
    (raw, ch: string) => {
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      if (ch === "r") return "\r";
      if (ch === "\\") return "\\";
      return raw;
    }
  );
}

/** 把 [start,end) 一段替换为 withText，返回新文本。 */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  withText: string
): string {
  return (
    text.slice(0, start) +
    withText +
    text.slice(end)
  );
}

/** 全部替换：按 findMatches 的区间从后往前逐处换（坐标不漂移）。 */
export function replaceAllMatches(
  text: string,
  find: string,
  withText: string,
  options: FindOptions
): string {
  let result = text;
  for (const [start, end] of [
    ...findMatches(text, find, options)
  ].reverse()) {
    result = replaceRange(
      result,
      start,
      end,
      withText
    );
  }
  return result;
}

type CommandDrawerProps = {
  /** 活动会话：命令默认发到它。 */
  session: OpenSession;
  /**
   * 发送出口。`broadcast` 为 true 时发到所有已打开会话（实现方用
   * broadcastTargets 选点），返回跳过的会话数。
   */
  onSend: (
    command: string,
    broadcast: boolean
  ) => number;
  /** 「发到所有」能覆盖的会话数（0 时禁用广播勾选）。 */
  broadcastCount: number;
  onClose: () => void;
};

export function CommandDrawer({
  session,
  onSend,
  broadcastCount,
  onClose
}: CommandDrawerProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [broadcast, setBroadcast] =
    useState(false);
  const [hint, setHint] = useState("");

  // ---- 查找替换挂件（浮在命令框右上角）----
  const [replaceOpen, setReplaceOpen] =
    useState(false);
  const [find, setFind] = useState("");
  const [withText, setWithText] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] =
    useState(false);
  const [wholeWord, setWholeWord] =
    useState(false);
  /** 当前高亮的匹配下标（-1 = 无）。 */
  const [matchIdx, setMatchIdx] = useState(-1);
  const inputRef =
    useRef<HTMLTextAreaElement>(null);
  const highlightRef =
    useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  /** 匹配选项聚成一个对象，随三个开关一起进 findMatches。 */
  const findOptions = useMemo(
    () => ({ regex, caseSensitive, wholeWord }),
    [regex, caseSensitive, wholeWord]
  );

  const matches = useMemo(
    () => findMatches(text, find, findOptions),
    [text, find, findOptions]
  );
  const regexOk = isRegexValid(find);
  const safeIdx =
    matches.length === 0
      ? -1
      : Math.min(
          Math.max(matchIdx, 0),
          matches.length - 1
        );

  // ---- 匹配高亮层：textarea 画不了分段背景，垫一层同字体参数的
  // 透明标记（等宽字体下坐标可精确算出），随 textarea 滚动同步 ----

  /** 与 .cmd-input 必须保持一致的排版常量（见 _sys-drawer.scss）。 */
  const LINE_H = 20;
  const PAD_Y = 8;
  const PAD_X = 10;
  const FONT = "13px Consolas, monospace";

  /** 等宽字符宽：canvas 实测一次，不同系统字体的微差不影响对齐。 */
  const charW = useMemo(() => {
    const ctx = document
      .createElement("canvas")
      .getContext("2d");
    if (!ctx) return 8;
    ctx.font = FONT;
    return ctx.measureText("M").width;
  }, []);

  /** 每个匹配拆成「行内段」：跨行匹配按行切开，逐段定位。 */
  const highlightSegs = useMemo(() => {
    if (matches.length === 0) return [];
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n")
        lineStarts.push(i + 1);
    }
    const rowOf = (pos: number) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        // 二界收敛，mid 恒在界内
        if (lineStarts[mid]! <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const segs: {
      row: number;
      col: number;
      len: number;
      current: boolean;
    }[] = [];
    matches.forEach(([s, e], i) => {
      let p = s;
      while (p < e) {
        const row = rowOf(p);
        // 本行的行尾（\n 之前的最后一个字符位置）
        const nextStart = lineStarts[row + 1];
        const lineEnd =
          nextStart === undefined
            ? text.length
            : nextStart - 1;
        const segEnd = Math.min(e, lineEnd);
        segs.push({
          row,
          col: p - lineStarts[row]!,
          len: segEnd - p,
          current: i === safeIdx
        });
        p = lineEnd;
      }
    });
    return segs;
  }, [text, matches, safeIdx]);

  /**
   * 把第 idx 处匹配设为「当前」（仅视觉高亮，不真选中）。
   *
   * ⚠️ **不能真 setSelectionRange + focus**：textarea 聚焦带选区时
   * 打字会按原生行为把选区替换掉（实测 bug：挂件开着打字直接毁命令）。
   * 高亮由 .cmd-highlight 标记层呈现，textarea 的选区/焦点不动。
   * 越界回绕；无匹配只清掉当前标记。滚动让当前匹配可见。
   */
  const focusMatch = (idx: number) => {
    if (matches.length === 0) {
      setMatchIdx(-1);
      return;
    }
    const next =
      ((idx % matches.length) + matches.length) %
      matches.length;
    setMatchIdx(next);
    const range = matches[next];
    if (!range) return;
    const input = inputRef.current;
    if (!input) return;
    // 当前匹配所在行滚进视口中部（不聚焦，不打断挂件里的输入）
    let firstRow = 0;
    for (let i = 0; i < range[0]; i++)
      if (text[i] === "\n") firstRow += 1;
    const target =
      firstRow * LINE_H -
      input.clientHeight / 2 +
      LINE_H / 2;
    input.scrollTop = Math.max(0, target);
  };

  /** 打开挂件：预填选中文本（VSCode 同款），焦点进查找框。 */
  const openReplace = () => {
    const input = inputRef.current;
    const selected =
      input?.selectionEnd !==
      input?.selectionStart
        ? text.slice(
            input?.selectionStart ?? 0,
            input?.selectionEnd ?? 0
          )
        : "";
    if (selected) setFind(selected);
    setReplaceOpen(true);
    // 焦点要等挂件渲染完再进查找框
    requestAnimationFrame(() =>
      findRef.current?.focus()
    );
  };

  const closeReplace = () => {
    setReplaceOpen(false);
    inputRef.current?.focus();
  };

  // 替换串：正则模式吃转义（\n/\t/\r/\\），字面模式原样
  const effectiveWith = regex
    ? unescapeReplacement(withText)
    : withText;

  const replaceCurrent = () => {
    if (matches.length === 0 || !regexOk) return;
    const idx = safeIdx === -1 ? 0 : safeIdx;
    const range = matches[idx];
    if (!range) return;
    setText(
      replaceRange(
        text,
        range[0],
        range[1],
        effectiveWith
      )
    );
    // 文本更新后的选区/下标同步交给上面的 effect
    setMatchIdx(
      Math.min(idx, matches.length - 2)
    );
  };

  const replaceAll = () => {
    if (matches.length === 0 || !regexOk) return;
    setText(
      replaceAllMatches(
        text,
        find,
        effectiveWith,
        findOptions
      )
    );
    setMatchIdx(-1);
  };

  const send = () => {
    const command = text.trim();
    if (!command) return;
    const skipped = onSend(command, broadcast);
    setHint(
      skipped > 0
        ? `${t("cmd.sent")}，${t("cmd.skipped")}: ${skipped}`
        : t("cmd.sent")
    );
    setText("");
    setMatchIdx(-1);
  };

  /** 查找框键盘：Enter/↑↓ 跳匹配，Esc 关挂件。 */
  const findKey = (
    event: React.KeyboardEvent
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeReplace();
    } else if (
      event.key === "Enter" ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      focusMatch(safeIdx + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMatch(safeIdx - 1);
    }
  };

  return (
    <div className="sys-drawer cmd-drawer">
      <div className="sys-drawer-head">
        <CodeOutlined className="sys-head-icon" />
        <span>{t("cmd.title")}</span>
        <small className="cmd-session">
          {session.name}
        </small>
        <div className="sys-drawer-actions">
          <button
            type="button"
            className="sys-icon-btn"
            aria-label={t("app.action.close")}
            onClick={onClose}
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
      <div className="sys-drawer-body cmd-body">
        <div className="cmd-input-wrap">
          {/* 匹配高亮层：垫在文字底下，坐标按等宽字体精确计算 */}
          <div
            ref={highlightRef}
            className="cmd-highlight"
            aria-hidden
          >
            {highlightSegs.map((seg, index) => (
              <span
                key={index}
                className={`cmd-mark${
                  seg.current ? " is-current" : ""
                }`}
                style={{
                  top: PAD_Y + seg.row * LINE_H,
                  left: PAD_X + seg.col * charW,
                  width: seg.len * charW,
                  height: LINE_H
                }}
              />
            ))}
          </div>
          <textarea
            ref={inputRef}
            className="cmd-input"
            value={text}
            placeholder={t("cmd.placeholder")}
            rows={3}
            onChange={event => {
              setText(event.target.value);
              setHint("");
            }}
            onScroll={event => {
              // 高亮层跟随滚动，文字与底色才不会错位
              if (highlightRef.current)
                highlightRef.current.scrollTop =
                  event.currentTarget.scrollTop;
            }}
            onKeyDown={event => {
              // 聚焦命令框时按「抽屉查找替换」键（默认 Ctrl+F，
              // 设置页可改）弹出挂件
              if (
                matchTerminalShortcut(
                  event,
                  "drawerFind"
                )
              ) {
                event.preventDefault();
                openReplace();
                return;
              }
              // Enter 发送（Shift+Enter 换行多行命令）
              if (
                event.key === "Enter" &&
                !event.shiftKey
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
          {/* ⌕ 常驻入口：鼠标党不开快捷键也能唤起挂件 */}
          <Button
            className="find-btn cmd-find-trigger"
            variant="tertiary"
            size="sm"
            aria-label={t("cmd.open")}
            onPress={() =>
              replaceOpen
                ? closeReplace()
                : openReplace()
            }
          >
            <SearchOutlined />
          </Button>
          {replaceOpen && (
            <Surface className="cmd-find-pop">
              <div className="cmd-find-row">
                <Input
                  ref={findRef}
                  className="find-input"
                  placeholder={t("cmd.find")}
                  value={find}
                  onChange={event => {
                    setFind(event.target.value);
                    setMatchIdx(0);
                  }}
                  onKeyDown={findKey}
                />
                <span className="find-count">
                  {regex && !regexOk
                    ? t("cmd.regexBad")
                    : matches.length > 0
                      ? `${safeIdx + 1}/${matches.length}`
                      : find
                        ? t("cmd.noMatch")
                        : ""}
                </span>
                <Hint label={t("cmd.prev")}>
                  <Button
                    className="find-btn"
                    variant="tertiary"
                    size="sm"
                    aria-label={t("cmd.prev")}
                    onPress={() =>
                      focusMatch(safeIdx - 1)
                    }
                  >
                    ↑
                  </Button>
                </Hint>
                <Hint label={t("cmd.next")}>
                  <Button
                    className="find-btn"
                    variant="tertiary"
                    size="sm"
                    aria-label={t("cmd.next")}
                    onPress={() =>
                      focusMatch(safeIdx + 1)
                    }
                  >
                    ↓
                  </Button>
                </Hint>
                <Hint
                  label={t(
                    "terminal.find.caseSensitive"
                  )}
                >
                  <ToggleButton
                    className="find-btn"
                    variant="ghost"
                    size="sm"
                    aria-label={t(
                      "terminal.find.caseSensitive"
                    )}
                    isSelected={caseSensitive}
                    onChange={() =>
                      setCaseSensitive(
                        value => !value
                      )
                    }
                  >
                    Aa
                  </ToggleButton>
                </Hint>
                <Hint label={t("cmd.wholeWord")}>
                  <ToggleButton
                    className="find-btn"
                    variant="ghost"
                    size="sm"
                    aria-label={t(
                      "cmd.wholeWord"
                    )}
                    isSelected={wholeWord}
                    onChange={() =>
                      setWholeWord(
                        value => !value
                      )
                    }
                  >
                    ab
                  </ToggleButton>
                </Hint>
                <Hint label={t("cmd.regex")}>
                  <ToggleButton
                    className="find-btn"
                    variant="ghost"
                    size="sm"
                    aria-label={t("cmd.regex")}
                    isSelected={regex}
                    onChange={() =>
                      setRegex(value => !value)
                    }
                  >
                    .*
                  </ToggleButton>
                </Hint>
                <Hint
                  label={t("app.action.close")}
                >
                  <Button
                    className="find-btn"
                    variant="tertiary"
                    size="sm"
                    aria-label={t(
                      "app.action.close"
                    )}
                    onPress={closeReplace}
                  >
                    ×
                  </Button>
                </Hint>
              </div>
              <div className="cmd-find-row">
                <Input
                  className="find-input"
                  value={withText}
                  placeholder={t(
                    "cmd.replaceWith"
                  )}
                  onChange={event =>
                    setWithText(
                      event.target.value
                    )
                  }
                  onKeyDown={event => {
                    // 替换框里 Enter = 替换当前处（VSCode 同款）
                    if (event.key === "Enter") {
                      event.preventDefault();
                      replaceCurrent();
                    }
                  }}
                />
                <Hint label={t("cmd.replace")}>
                  <Button
                    className="find-btn find-text-btn"
                    variant="tertiary"
                    size="sm"
                    onPress={() => {
                      // 无匹配/正则非法时给反馈而不是死按钮
                      if (matches.length === 0)
                        setHint(t("cmd.noMatch"));
                      else if (!regexOk)
                        setHint(
                          t("cmd.regexBad")
                        );
                      else replaceCurrent();
                    }}
                  >
                    {t("cmd.replace")}
                  </Button>
                </Hint>
                <Hint label={t("cmd.replaceAll")}>
                  <Button
                    className="find-btn find-text-btn"
                    variant="tertiary"
                    size="sm"
                    onPress={() => {
                      if (matches.length === 0)
                        setHint(t("cmd.noMatch"));
                      else if (!regexOk)
                        setHint(
                          t("cmd.regexBad")
                        );
                      else replaceAll();
                    }}
                  >
                    {t("cmd.replaceAll")}
                  </Button>
                </Hint>
              </div>
            </Surface>
          )}
          {/* 发送动作浮在输入框右下角（与右上角 ⌕ 对称） */}
          <div className="cmd-actions">
            {broadcastCount > 0 && (
              <ToggleButton
                className="find-btn find-text-btn"
                variant="ghost"
                size="sm"
                isSelected={broadcast}
                onChange={setBroadcast}
              >
                {t("cmd.sendAll")} (
                {broadcastCount})
              </ToggleButton>
            )}
            <button
              type="button"
              className="cmd-send"
              disabled={!text.trim()}
              onClick={send}
            >
              <SendOutlined />
              {t("cmd.send")}
            </button>
            <span className="cmd-hint">
              {hint}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
