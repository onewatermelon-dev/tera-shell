import { useState, type ReactNode } from "react";
import { Button, Modal } from "@heroui/react";
import {
  CheckOutlined,
  CloseOutlined,
  LockOutlined,
  PlusOutlined,
  QuestionCircleOutlined
} from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import Toggle from "@/shared/components/Toggle";
import { useT } from "@/settings/lib/i18n";
import {
  defaultModelDraft,
  type ModelDraft,
  type ModelEntry
} from "@/settings/lib/modelProviders";

/** 可选输入类型与能力开关；「文本」恒选中且锁定，不进数组。 */
const INPUT_TYPES = ["image", "video", "pdf"];
const CAPABILITIES = [
  "structured",
  "webSearch",
  "systemMessages"
];

/**
 * 标签旁的 ?：悬停显示字段说明，气泡贴圈左下；pre-line 支持文案里的换行。
 * tip 缺省用 text；需要带排版（粗体 / 列表）的说明才单独传 ReactNode。
 */
function FieldHint({
  text,
  tip
}: {
  text: string;
  tip?: ReactNode;
}) {
  return (
    <Hint
      label={tip ?? text}
      placement="bottom left"
      className="model-hint-pop"
    >
      <Button
        className="model-field-hint"
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={text}
      >
        <QuestionCircleOutlined />
      </Button>
    </Hint>
  );
}

type ModelDialogProps = {
  /** 编辑时传入已有模型；新增时省略（或传 null）。 */
  model?: ModelEntry | null;
  /** 保存整份草稿（父级决定是新增还是更新）。 */
  onSave: (draft: ModelDraft) => void;
  onClose: () => void;
};

/**
 * 添加 / 编辑模型弹窗：名称、智能配置、上下文窗口、最大输出 Token，
 * 外加可折叠的「高级配置」（输入类型、模型能力、推理等级、推理参数映射）。
 *
 * 与项目其他对话框一致：父级条件渲染、`isOpen` 恒真、关闭靠父级卸载。
 * 表单状态是一份本地草稿，点「保存」才交出去 —— 取消即丢弃。
 */
export default function ModelDialog({
  model,
  onSave,
  onClose
}: ModelDialogProps) {
  const t = useT();
  const editing = model != null;
  // t() 的键是字面量联合，动态拼不出来 —— 选项文案做成查表
  const inputLabels: Record<string, string> = {
    image: t("models.inputImage"),
    video: t("models.inputVideo"),
    pdf: t("models.inputPdf")
  };
  const capLabels: Record<string, string> = {
    structured: t("models.capStructured"),
    webSearch: t("models.capWebSearch"),
    systemMessages: t("models.capSysMsg")
  };
  const [draft, setDraft] = useState<ModelDraft>(
    () =>
      model
        ? {
            name: model.name,
            enabled: model.enabled,
            smartConfig: model.smartConfig,
            contextWindow: model.contextWindow,
            maxOutputTokens:
              model.maxOutputTokens,
            inputTypes: [...model.inputTypes],
            capabilities: [...model.capabilities],
            reasoningLevels: [
              ...model.reasoningLevels
            ],
            reasoningMapping:
              model.reasoningMapping
          }
        : defaultModelDraft()
  );

  /** 局部改草稿；数组字段调用方自己给新数组。 */
  function patch(next: Partial<ModelDraft>) {
    setDraft(prev => ({
      ...prev,
      ...next
    }));
  }

  /** 在字符串数组里加 / 去一个值。 */
  function toggleIn(
    list: string[],
    value: string
  ): string[] {
    return list.includes(value)
      ? list.filter(item => item !== value)
      : [...list, value];
  }

  const canSave = draft.name.trim() !== "";

  function submit() {
    if (!canSave) return;
    onSave({
      ...draft,
      name: draft.name.trim()
    });
    onClose();
  }

  return (
    <Modal
      isOpen
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      {/* 截图观感：弹窗出现时背景高斯模糊，而不是压暗 */}
      <Modal.Backdrop variant="blur">
        <Modal.Container
          placement="center"
          size="md"
        >
          <Modal.Dialog className="model-dialog">
            <Modal.Header>
              <Modal.Heading>
                {editing
                  ? t("models.editModel")
                  : t("models.addModel")}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={t("app.action.close")}
              />
            </Modal.Header>
            <Modal.Body className="model-dialog-body">
              <div className="model-form-switch">
                <span className="model-field-label">
                  {t("models.smartConfig")}
                  <FieldHint
                    text={t("models.hint.smart")}
                  />
                </span>
                <Toggle
                  ariaLabel={t(
                    "models.smartConfig"
                  )}
                  isSelected={draft.smartConfig}
                  onChange={smartConfig =>
                    patch({ smartConfig })
                  }
                />
              </div>

              <div className="model-form-field">
                <span className="model-field-label">
                  {t("models.name")}
                </span>
                <input
                  className="settings-input"
                  value={draft.name}
                  autoFocus
                  spellCheck={false}
                  aria-label={t("models.name")}
                  placeholder={t(
                    "models.modelPlaceholder"
                  )}
                  onChange={event =>
                    patch({
                      name: event.target.value
                    })
                  }
                />
              </div>

              <div className="model-form-field">
                <span className="model-field-label">
                  {t("models.contextWindow")}
                  <FieldHint
                    text={t(
                      "models.hint.context"
                    )}
                  />
                </span>
                <input
                  className="settings-input"
                  value={draft.contextWindow}
                  spellCheck={false}
                  aria-label={t(
                    "models.contextWindow"
                  )}
                  onChange={event =>
                    patch({
                      contextWindow:
                        event.target.value
                    })
                  }
                />
              </div>

              <div className="model-form-field">
                <span className="model-field-label">
                  {t("models.maxTokens")}
                  <FieldHint
                    text={t(
                      "models.hint.maxTokens"
                    )}
                  />
                </span>
                <input
                  className="settings-input"
                  value={draft.maxOutputTokens}
                  spellCheck={false}
                  aria-label={t(
                    "models.maxTokens"
                  )}
                  onChange={event =>
                    patch({
                      maxOutputTokens:
                        event.target.value
                    })
                  }
                />
              </div>

              {/* 高级配置：默认收起，details 原生折叠零 JS */}
              <details className="model-advanced">
                <summary>
                  {t("models.advanced")}
                </summary>

                <div className="model-form-field">
                  <span className="model-field-label">
                    {t("models.inputTypes")}
                    <FieldHint
                      text={t(
                        "models.hint.input"
                      )}
                    />
                  </span>
                  <div className="model-chip-row">
                    {/* 文本恒选中且锁定：所有模型都要能吃文本输入 */}
                    <span className="model-chip is-on is-locked">
                      <span className="model-chip-box">
                        <CheckOutlined />
                      </span>
                      {t("models.inputText")}
                      <LockOutlined className="model-chip-lock" />
                    </span>
                    {INPUT_TYPES.map(type => (
                      <button
                        key={type}
                        type="button"
                        className={
                          draft.inputTypes.includes(
                            type
                          )
                            ? "model-chip is-on"
                            : "model-chip"
                        }
                        onClick={() =>
                          patch({
                            inputTypes: toggleIn(
                              draft.inputTypes,
                              type
                            )
                          })
                        }
                      >
                        <span className="model-chip-box">
                          {draft.inputTypes.includes(
                            type
                          ) && <CheckOutlined />}
                        </span>
                        {inputLabels[type]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="model-form-field">
                  <span className="model-field-label">
                    {t("models.capabilities")}
                    {/* 图纸样式：每条能力一行，名字加粗，末尾一句警告 */}
                    <FieldHint
                      text={t("models.hint.cap")}
                      tip={
                        <>
                          <ul className="model-hint-list">
                            <li>
                              <strong>
                                {t(
                                  "models.capStructured"
                                )}
                              </strong>
                              ：
                              {t(
                                "models.capStructuredDesc"
                              )}
                            </li>
                            <li>
                              <strong>
                                {t(
                                  "models.capWebSearch"
                                )}
                              </strong>
                              ：
                              {t(
                                "models.capWebSearchDesc"
                              )}
                            </li>
                            <li>
                              <strong>
                                {t(
                                  "models.capSysMsg"
                                )}
                              </strong>
                              ：
                              {t(
                                "models.capSysMsgDesc"
                              )}
                            </li>
                          </ul>
                          {t("models.capWarn")}
                        </>
                      }
                    />
                  </span>
                  <div className="model-chip-row">
                    {CAPABILITIES.map(cap => (
                      <button
                        key={cap}
                        type="button"
                        className={
                          draft.capabilities.includes(
                            cap
                          )
                            ? "model-chip is-on"
                            : "model-chip"
                        }
                        onClick={() =>
                          patch({
                            capabilities:
                              toggleIn(
                                draft.capabilities,
                                cap
                              )
                          })
                        }
                      >
                        <span className="model-chip-box">
                          {draft.capabilities.includes(
                            cap
                          ) && <CheckOutlined />}
                        </span>
                        {capLabels[cap]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="model-form-field">
                  <span className="model-field-label">
                    {t("models.reasoningLevels")}
                    <FieldHint
                      text={t(
                        "models.hint.levels"
                      )}
                    />
                  </span>
                  <div className="model-chip-row">
                    {draft.reasoningLevels.map(
                      (level, index) => (
                        <span
                          key={index}
                          className="model-tag"
                        >
                          <input
                            className="model-tag-input"
                            value={level}
                            spellCheck={false}
                            aria-label={t(
                              "models.reasoningLevels"
                            )}
                            onChange={event =>
                              patch({
                                reasoningLevels:
                                  draft.reasoningLevels.map(
                                    (item, at) =>
                                      at === index
                                        ? event
                                            .target
                                            .value
                                        : item
                                  )
                              })
                            }
                          />
                          <button
                            type="button"
                            aria-label={t(
                              "models.removeLevel"
                            )}
                            onClick={() =>
                              patch({
                                reasoningLevels:
                                  draft.reasoningLevels.filter(
                                    (_, at) =>
                                      at !== index
                                  )
                              })
                            }
                          >
                            <CloseOutlined />
                          </button>
                        </span>
                      )
                    )}
                    <button
                      type="button"
                      className="model-tag-add"
                      aria-label={t(
                        "models.reasoningLevels"
                      )}
                      onClick={() =>
                        patch({
                          reasoningLevels: [
                            ...draft.reasoningLevels,
                            ""
                          ]
                        })
                      }
                    >
                      <PlusOutlined />
                    </button>
                  </div>
                </div>

                <div className="model-form-field">
                  <span className="model-field-label">
                    {t("models.reasoningMapping")}
                    <FieldHint
                      text={t(
                        "models.hint.mapping"
                      )}
                    />
                  </span>
                  <textarea
                    className="settings-input model-mapping"
                    rows={4}
                    value={draft.reasoningMapping}
                    spellCheck={false}
                    aria-label={t(
                      "models.reasoningMapping"
                    )}
                    onChange={event =>
                      patch({
                        reasoningMapping:
                          event.target.value
                      })
                    }
                  />
                </div>
              </details>
            </Modal.Body>
            <Modal.Footer className="model-dialog-foot">
              <Button
                variant="ghost"
                size="sm"
                className="model-reset"
                onPress={() =>
                  setDraft(defaultModelDraft())
                }
              >
                {t("models.resetForm")}
              </Button>
              <div className="model-dialog-actions">
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
              </div>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
