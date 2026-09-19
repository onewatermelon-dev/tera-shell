import { useState } from "react";
import {
  Button,
  Modal,
  Typography
} from "@heroui/react";
import { useT } from "@/settings/lib/i18n";
import type { TerminalMacro } from "@/terminal/lib/terminalMacros";

type MacroDialogProps = {
  /** 编辑时传入已有的宏；新增时省略（或传 null）。 */
  macro?: TerminalMacro | null;
  /** 保存：name 留空时用命令兜底。 */
  onSave: (name: string, command: string) => void;
  onClose: () => void;
};

/**
 * 新增 / 编辑快捷宏的小弹窗：填名称与命令，保存后成为宏栏上的一个按钮。
 *
 * 与项目里其他对话框一致，父级条件渲染、`isOpen` 恒真、关闭靠父级卸载。
 * 同一个弹窗兼顾两种模式 —— 字段就两个，没必要拆成两个组件；
 * 靠 `macro` 有无来区分标题与初始值。
 */
export default function MacroDialog({
  macro,
  onSave,
  onClose
}: MacroDialogProps) {
  const t = useT();
  const editing = macro != null;
  const [name, setName] = useState(
    macro?.name ?? ""
  );
  const [command, setCommand] = useState(
    macro?.command ?? ""
  );
  // 命令为空时保存没有意义；名称可以留空（退化为命令本身）
  const canSave = command.trim() !== "";

  function submit() {
    if (!canSave) return;
    onSave(name.trim(), command.trim());
    onClose();
  }

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container
          placement="center"
          size="xs"
        >
          <Modal.Dialog className="new-entry-dialog">
            <Modal.Header>
              <Typography.Paragraph
                size="sm"
                className="dialog-eyebrow"
              >
                终端
              </Typography.Paragraph>
              <Modal.Heading>
                {editing
                  ? t("macro.edit")
                  : t("macro.add")}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body className="new-entry-body">
              <input
                className="new-entry-name"
                value={name}
                autoFocus
                spellCheck={false}
                aria-label={t("macro.name")}
                placeholder={t(
                  "macro.namePlaceholder"
                )}
                onChange={event =>
                  setName(event.target.value)
                }
                onKeyDown={event => {
                  if (event.key === "Enter")
                    submit();
                }}
              />
              {/* 命令用 textarea：允许一次粘一串命令，执行时逐行下发 */}
              <textarea
                className="new-entry-name macro-command"
                value={command}
                rows={4}
                spellCheck={false}
                aria-label={t("macro.command")}
                placeholder={t(
                  "macro.commandPlaceholder"
                )}
                onChange={event =>
                  setCommand(event.target.value)
                }
                onKeyDown={event => {
                  // Enter 直接提交，换行交给 Ctrl/Alt+Enter ——
                  // 单行场景占多数，敲完回车就保存更符合直觉
                  if (
                    event.key === "Enter" &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    !event.shiftKey
                  ) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                size="sm"
                onPress={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={!canSave}
                onPress={submit}
              >
                {t("common.save")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
