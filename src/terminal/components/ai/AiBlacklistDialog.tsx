import { useState } from "react";
import {
  Button,
  Input,
  Modal
} from "@heroui/react";
import {
  MinusCircleFilled,
  PlusOutlined
} from "@ant-design/icons";
import { useT } from "@/settings/lib/i18n";

type Props = {
  blacklist: string[];
  onChange: (list: string[]) => void;
  onClose: () => void;
};

/**
 * 自动执行命令黑名单配置弹窗：黑名单中的命令不会被 AI 自动执行，
 * 一律回落为确认卡片。增删即改即存（localStorage，由父层持久化）。
 */
export default function AiBlacklistDialog({
  blacklist,
  onChange,
  onClose
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");

  function add() {
    const name = draft
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.toLowerCase();
    if (!name || blacklist.includes(name)) return;
    onChange([...blacklist, name]);
    setDraft("");
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
          size="sm"
        >
          <Modal.Dialog className="ai-risk-dialog ai-blacklist-dialog">
            <Modal.Header>
              <Modal.Heading>
                <span className="ai-risk-title">
                  <MinusCircleFilled className="ai-risk-icon ai-blacklist-icon" />
                  {t("ai.blacklist.title")}
                </span>
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body>
              <p className="ai-blacklist-lead">
                {t("ai.blacklist.lead")}
              </p>
              <div className="ai-blacklist-input">
                <Input
                  aria-label={t(
                    "ai.blacklist.placeholder"
                  )}
                  placeholder={t(
                    "ai.blacklist.placeholder"
                  )}
                  value={draft}
                  onChange={event =>
                    setDraft(event.target.value)
                  }
                  onKeyDown={event => {
                    if (event.key === "Enter")
                      add();
                  }}
                />
                <Button
                  variant="tertiary"
                  size="sm"
                  isIconOnly
                  className="ai-blacklist-add"
                  aria-label={t(
                    "ai.blacklist.add"
                  )}
                  onPress={add}
                >
                  <PlusOutlined />
                </Button>
              </div>
              <ul className="ai-blacklist-list">
                {blacklist.map(name => (
                  <li key={name}>
                    <span className="ai-blacklist-name">
                      <MinusCircleFilled className="ai-blacklist-icon" />
                      {name}
                    </span>
                    <button
                      type="button"
                      className="ai-blacklist-remove"
                      aria-label={`${t(
                        "ai.blacklist.remove"
                      )} ${name}`}
                      onClick={() =>
                        onChange(
                          blacklist.filter(
                            item => item !== name
                          )
                        )
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                size="sm"
                isDisabled={
                  blacklist.length === 0
                }
                onPress={() => onChange([])}
              >
                {t("ai.blacklist.clear")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={onClose}
              >
                {t("ai.blacklist.close")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
