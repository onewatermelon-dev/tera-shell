/**
 * 「主机档案」下拉：这台机器的 Markdown 备忘，textarea 直改即存。
 *
 * 档案会截断注入每次 AI 请求的上下文（workspaceContext），所以这里
 * 写的角色、关键路径、已知坑，AI 开口前就知道。与 AiHistoryMenu 同构：
 * 开合状态、点击外部关闭自包含，面板只经 props 接入 session。
 */
import {
  useEffect,
  useRef,
  useState
} from "react";
import { ProfileOutlined } from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";
import {
  hostKeyOfSession,
  loadHostNote,
  saveHostNote
} from "@/terminal/lib/ai/hostNotes";
import type { OpenSession } from "@/terminal/lib/session/terminalTypes";

export function AiHostNotes({
  session
}: {
  session: OpenSession;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const savedTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (
        !wrapRef.current?.contains(
          event.target as Node
        )
      )
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener(
      "pointerdown",
      onDown
    );
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener(
        "pointerdown",
        onDown
      );
      document.removeEventListener(
        "keydown",
        onKey
      );
    };
  }, [open]);

  useEffect(
    () => () => {
      // 卸载时清掉「已保存」提示的定时器
      if (savedTimer.current !== null)
        clearTimeout(savedTimer.current);
    },
    []
  );

  function toggle() {
    setDraft(
      loadHostNote(hostKeyOfSession(session))
    );
    setSaved(false);
    setOpen(value => !value);
  }

  function save() {
    saveHostNote(
      hostKeyOfSession(session),
      draft
    );
    setSaved(true);
    if (savedTimer.current !== null)
      clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(
      () => setSaved(false),
      2000
    );
  }

  return (
    <div
      className="ai-history-wrap"
      ref={wrapRef}
    >
      <button
        type="button"
        className="ai-panel-clear"
        aria-label={t("ai.hostNotes")}
        title={t("ai.hostNotes")}
        aria-expanded={open}
        onClick={toggle}
      >
        <ProfileOutlined />
      </button>
      {open && (
        <div
          className="ai-history-menu ai-hostnotes-menu"
          role="dialog"
          aria-label={t("ai.hostNotes")}
        >
          <textarea
            className="ai-hostnotes-editor"
            value={draft}
            onChange={event =>
              setDraft(event.target.value)
            }
            placeholder={t(
              "ai.hostNotes.placeholder"
            )}
            spellCheck={false}
          />
          <div className="ai-hostnotes-foot">
            <span className="ai-hostnotes-count">
              {draft.length}
            </span>
            <button
              type="button"
              className="ai-hostnotes-save"
              onClick={save}
            >
              {saved
                ? t("ai.hostNotes.saved")
                : t("ai.hostNotes.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
