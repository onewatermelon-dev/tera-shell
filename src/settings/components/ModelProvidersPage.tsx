import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Dropdown,
  EmptyState,
  ProgressCircle,
  Typography
} from "@heroui/react";
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  EllipsisOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  InfoCircleOutlined,
  PlusOutlined
} from "@ant-design/icons";
import Hint from "@/shared/components/Hint";
import Toggle from "@/shared/components/Toggle";
import SettingsSelect, {
  type SelectOption
} from "@/settings/components/SettingsSelect";
import ModelDialog from "@/settings/components/ModelDialog";
import {
  useT,
  type Translator
} from "@/settings/lib/i18n";
import { useModelProviders } from "@/settings/lib/useModelProviders";
import {
  formatContextWindow,
  type ApiFormat,
  type ModelEntry,
  type ModelProvider
} from "@/settings/lib/modelProviders";

/** 三种 API 格式的最小测试请求：端点路径 + 请求体 + 鉴权头。 */
function buildTestRequest(
  provider: ModelProvider,
  model: ModelEntry
): {
  url: string;
  headers: Record<string, string>;
  body: object;
} {
  const base = provider.baseUrl.replace(
    /\/+$/,
    ""
  );
  // max_tokens 用模型配置里的「最大输出 Token」，没填给 16 兜底
  // （思考类模型嫌 1 太小会直接 400）。上下文窗口是容量声明，
  // 不是接口参数，不进请求体。
  const maxTokens =
    Number(
      model.maxOutputTokens.replace(/,/g, "")
    ) || 16;
  if (provider.apiFormat === "anthropic")
    return {
      url: `${base}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: {
        model: model.name,
        max_tokens: maxTokens,
        messages: [
          { role: "user", content: "ping" }
        ]
      }
    };
  if (provider.apiFormat === "responses")
    return {
      url: `${base}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`
      },
      body: { model: model.name, input: "ping" }
    };
  return {
    url: `${base}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: {
      model: model.name,
      max_tokens: maxTokens,
      messages: [
        { role: "user", content: "ping" }
      ]
    }
  };
}

/** API 格式下拉的三项（顺序与文案照截图；纯文字，不带图标）。 */
const formatOptions = (
  t: Translator
): SelectOption<ApiFormat>[] => [
  {
    value: "anthropic",
    label: t("models.format.anthropic")
  },
  {
    value: "openai",
    label: t("models.format.openai")
  },
  {
    value: "responses",
    label: t("models.format.responses")
  }
];

/**
 * 模型设置页：左列供应商清单，右列选中供应商的详情编辑。
 *
 * 所有字段即改即存（useModelProviders 每次变更都落盘）—— 这些输入
 * 不像终端字体那样触发重排，不需要「草稿 + 保存」那一套。
 */
export default function ModelProvidersPage() {
  const t = useT();
  const store = useModelProviders();
  const { providers } = store;
  const [selectedId, setSelectedId] =
    useState("");
  const [showKey, setShowKey] = useState(false);
  // 「重命名」菜单项聚焦这个名字输入框用
  const nameRef = useRef<HTMLInputElement>(null);
  // 模型弹窗：null 关闭；editing 有值 = 编辑该模型，否则新增
  const [modelDialog, setModelDialog] = useState<{
    editing: ModelEntry | null;
  } | null>(null);
  // 测试连通性状态条：模型列表下方，进行中 / 成功 / 失败三态；
  // 结果态 3 秒自动收起，也可点 × 手动关
  const [testBanner, setTestBanner] = useState<{
    id: string;
    label: string;
    state: "testing" | "ok" | "fail";
    detail?: string;
  } | null>(null);
  const testTimer =
    useRef<ReturnType<typeof setTimeout>>(
      undefined
    );

  /** 给模型发一条最小请求验证 Base URL / Key / 模型名可用。 */
  async function testModel(model: ModelEntry) {
    if (!selected || !model.name) return;
    const label = `${selected.name || t("models.newProvider")} / ${model.name}`;
    clearTimeout(testTimer.current);
    setTestBanner({
      id: model.id,
      label,
      state: "testing"
    });
    const { url, headers, body } =
      buildTestRequest(selected, model);
    // 请求从 Rust 侧发（infra::http::http_post_json）：
    // WebView2 里直接 fetch 会被模型网关的 CORS 拦掉，还看不到原因
    console.info("[model-test] POST", url, {
      format: selected.apiFormat,
      model: model.name
    });
    let ok = false;
    let detail = "";
    try {
      const status = await invoke<number>(
        "http_post_json",
        { url, headers, body }
      );
      ok = status >= 200 && status < 300;
      // 非 2xx 把状态码带进状态条：401=Key 不对、404=地址/模型名不对
      detail = ok ? "" : `HTTP ${status}`;
      console.info(
        "[model-test] 响应",
        url,
        status
      );
    } catch (reason) {
      // invoke 本身的错误（如没重启后端 → command not found）也显示出来
      detail = String(reason).slice(0, 120);
      console.error(
        "[model-test] 请求失败",
        url,
        reason
      );
    }
    setTestBanner(prev =>
      prev && prev.id === model.id
        ? {
            ...prev,
            state: ok ? "ok" : "fail",
            detail
          }
        : prev
    );
    testTimer.current = setTimeout(
      () => setTestBanner(null),
      3000
    );
  }
  const formats = useMemo(
    () => formatOptions(t),
    [t]
  );
  // 选中的供应商被删掉 / 列表变化时退回第一只：派生而不是 effect 里 setState
  const selected =
    providers.find(
      item => item.id === selectedId
    ) ?? providers[0];

  function createProvider() {
    const provider = store.add(
      t("models.newProvider")
    );
    setSelectedId(provider.id);
  }

  return (
    <div className="models-page">
      <div className="models-toolbar">
        <p className="models-desc">
          {t("models.desc")}
        </p>
        <Button
          variant="primary"
          size="sm"
          onPress={createProvider}
        >
          <PlusOutlined />
          {t("models.addProvider")}
        </Button>
      </div>

      <div className="models-body">
        <aside className="models-list">
          {providers.length === 0 && (
            <p className="models-empty">
              {t("models.empty")}
            </p>
          )}
          {providers.map(provider => (
            <button
              key={provider.id}
              type="button"
              className={
                provider.id === selected?.id
                  ? "model-item is-active"
                  : "model-item"
              }
              onClick={() =>
                setSelectedId(provider.id)
              }
            >
              <ApiOutlined className="model-item-icon" />
              <span className="model-item-name">
                {provider.name ||
                  t("models.newProvider")}
              </span>
              {/* 状态点：绿＝已启用，橙＝已停用（与截图同一套语义） */}
              <span
                className={`model-dot${
                  provider.enabled ? "" : " off"
                }`}
              />
            </button>
          ))}
        </aside>

        {selected ? (
          <div className="model-detail">
            <div className="model-detail-head">
              <ApiOutlined className="model-detail-icon" />
              {/* 名字：平时是透明无边框的「文字」，点进去才现出编辑框 */}
              <input
                ref={nameRef}
                className="model-name"
                value={selected.name}
                spellCheck={false}
                aria-label={t("models.name")}
                placeholder={t(
                  "models.newProvider"
                )}
                onChange={event =>
                  store.update(selected.id, {
                    name: event.target.value
                  })
                }
              />
              {/* 启用/禁用供应商：关掉后左列状态点变灰 */}
              <Hint
                label={t(
                  selected.enabled
                    ? "models.disableProvider"
                    : "models.enableProvider"
                )}
                placement="top"
              >
                <Toggle
                  ariaLabel={t("models.enabled")}
                  isSelected={selected.enabled}
                  onChange={enabled =>
                    store.update(selected.id, {
                      enabled
                    })
                  }
                />
              </Hint>
              {/* 「…」菜单：重命名聚焦名字输入框，删除走红色项（图纸样式） */}
              <Dropdown.Root>
                <Dropdown.Trigger
                  className="model-more-btn"
                  aria-label={t(
                    "app.action.more"
                  )}
                >
                  <EllipsisOutlined />
                </Dropdown.Trigger>
                <Dropdown.Popover
                  placement="bottom end"
                  className="model-menu-pop"
                >
                  <Dropdown.Menu
                    aria-label={t(
                      "app.action.more"
                    )}
                    onAction={key => {
                      if (key === "rename") {
                        // 菜单收起后 RAC 会把焦点还给「…」触发器，
                        // 同步 focus() 会被盖掉 —— 等这一帧结束再抢，
                        // 顺带全选方便直接改
                        requestAnimationFrame(
                          () =>
                            nameRef.current?.select()
                        );
                        return;
                      }
                      if (key === "delete") {
                        store.remove(selected.id);
                        setSelectedId("");
                      }
                    }}
                  >
                    <Dropdown.Item
                      id="rename"
                      textValue={t(
                        "models.rename"
                      )}
                    >
                      <EditOutlined className="model-menu-icon" />
                      {t("models.rename")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      id="delete"
                      textValue={t(
                        "models.delete"
                      )}
                      className="model-menu-danger"
                    >
                      <DeleteOutlined className="model-menu-icon" />
                      {t("models.delete")}
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            </div>

            <div className="model-field">
              <span className="model-field-label">
                {t("models.baseUrl")}
              </span>
              <input
                className="settings-input"
                value={selected.baseUrl}
                spellCheck={false}
                aria-label={t("models.baseUrl")}
                placeholder="https://api.example.com/v1"
                onChange={event =>
                  store.update(selected.id, {
                    baseUrl: event.target.value
                  })
                }
              />
            </div>

            <div className="model-field">
              <span className="model-field-label">
                {t("models.apiFormat")}
              </span>
              <SettingsSelect
                value={selected.apiFormat}
                options={formats}
                ariaLabel={t("models.apiFormat")}
                className="model-format"
                onChange={apiFormat =>
                  store.update(selected.id, {
                    apiFormat
                  })
                }
              />
            </div>

            <div className="model-field">
              <span className="model-field-label">
                {t("models.key")}
              </span>
              <div className="model-key-wrap">
                <input
                  className="settings-input model-key-input"
                  type={
                    showKey ? "text" : "password"
                  }
                  value={selected.apiKey}
                  spellCheck={false}
                  aria-label={t("models.key")}
                  onChange={event =>
                    store.update(selected.id, {
                      apiKey: event.target.value
                    })
                  }
                />
                {/* 眼睛钉在输入框内右端（绝对定位），文字给它让出右侧空间 */}
                <Button
                  className="model-key-eye"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label={t("models.showKey")}
                  onPress={() =>
                    setShowKey(value => !value)
                  }
                >
                  {showKey ? (
                    <EyeInvisibleOutlined />
                  ) : (
                    <EyeOutlined />
                  )}
                </Button>
              </div>
            </div>

            <div className="model-list-head">
              <span className="model-field-label">
                {t("models.list")}
              </span>
              <Button
                variant="tertiary"
                size="sm"
                onPress={() =>
                  setModelDialog({
                    editing: null
                  })
                }
              >
                <PlusOutlined />
                {t("models.addModel")}
              </Button>
            </div>
            {selected.models.length === 0 && (
              <div className="model-list-empty">
                <InfoCircleOutlined />
                {t("models.noModels")}
              </div>
            )}
            <div className="model-rows">
              {selected.models.map(model => (
                <div
                  key={model.id}
                  className="model-row"
                >
                  {/* 名字与高级字段都在弹窗里改，行上只展示 */}
                  <span className="model-row-name">
                    {model.name ||
                      t(
                        "models.modelPlaceholder"
                      )}
                  </span>
                  {/* 标签从已填的字段推导：上下文窗口；能吃图片输入即「视觉」 */}
                  {model.contextWindow && (
                    <span className="model-row-tag">
                      {formatContextWindow(
                        model.contextWindow
                      )}
                    </span>
                  )}
                  {model.inputTypes.includes(
                    "image"
                  ) && (
                    <span className="model-row-tag">
                      {t("models.vision")}
                    </span>
                  )}
                  {/* 撑开名字/标签与操作区的间距 */}
                  <span className="model-row-gap" />
                  {/* 测试连通性：结果在列表下方的状态条里显示 */}
                  <Hint
                    label={t("models.testModel")}
                    placement="top"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={t(
                        "models.testModel"
                      )}
                      isDisabled={
                        testBanner?.id ===
                          model.id &&
                        testBanner.state ===
                          "testing"
                      }
                      onPress={() =>
                        void testModel(model)
                      }
                    >
                      <DisconnectOutlined />
                    </Button>
                  </Hint>
                  <Hint
                    label={t("models.editModel")}
                    placement="top"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={t(
                        "models.editModel"
                      )}
                      onPress={() =>
                        setModelDialog({
                          editing: model
                        })
                      }
                    >
                      <EditOutlined />
                    </Button>
                  </Hint>
                  <Button
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    aria-label={t(
                      "models.deleteModel"
                    )}
                    onPress={() =>
                      store.removeModel(
                        selected.id,
                        model.id
                      )
                    }
                  >
                    <DeleteOutlined />
                  </Button>
                  {/* 启用开关放最右：测试 / 编辑 / 删除 / 开关（截图顺序） */}
                  <Toggle
                    ariaLabel={t(
                      "models.enabled"
                    )}
                    isSelected={model.enabled}
                    onChange={enabled =>
                      store.updateModel(
                        selected.id,
                        model.id,
                        { enabled }
                      )
                    }
                  />
                </div>
              ))}
            </div>
            {testBanner && (
              <div
                className={`model-test-banner ${testBanner.state}`}
              >
                {testBanner.state ===
                "testing" ? (
                  /* HeroUI 环形进度条，不定量模式（轨道要复合 children 才画得出） */
                  <ProgressCircle
                    className="model-progress"
                    size="sm"
                    color="accent"
                    isIndeterminate
                    value={50}
                    aria-label={t(
                      "models.testing",
                      {
                        name: testBanner.label
                      }
                    )}
                  >
                    <ProgressCircle.Track>
                      <ProgressCircle.TrackCircle />
                      <ProgressCircle.FillCircle />
                    </ProgressCircle.Track>
                  </ProgressCircle>
                ) : testBanner.state === "ok" ? (
                  <CheckCircleOutlined />
                ) : (
                  <CloseCircleOutlined />
                )}
                <span>
                  {testBanner.state === "testing"
                    ? t("models.testing", {
                        name: testBanner.label
                      })
                    : t(
                        testBanner.state === "ok"
                          ? "models.testOk"
                          : "models.testFail",
                        { name: testBanner.label }
                      )}
                  {testBanner.state !== "ok" &&
                    testBanner.detail && (
                      <span className="model-test-detail">
                        ：{testBanner.detail}
                      </span>
                    )}
                </span>
                {/* × 按钮恒渲染（测试中只藏不删）：右侧槽位宽度不变，
                    文字在「测试中 / 结果」两态下位置完全一致 */}
                <button
                  type="button"
                  className={
                    testBanner.state === "testing"
                      ? "model-test-close is-hidden"
                      : "model-test-close"
                  }
                  aria-label={t(
                    "app.action.close"
                  )}
                  onClick={() => {
                    clearTimeout(
                      testTimer.current
                    );
                    setTestBanner(null);
                  }}
                >
                  <CloseOutlined />
                </button>
              </div>
            )}
          </div>
        ) : (
          <EmptyState className="model-detail model-detail--empty">
            <Typography.Paragraph
              size="sm"
              className="models-empty"
            >
              {t("models.empty")}
            </Typography.Paragraph>
          </EmptyState>
        )}
      </div>

      {modelDialog && selected && (
        <ModelDialog
          key={modelDialog.editing?.id ?? "new"}
          model={modelDialog.editing}
          onSave={draft => {
            if (modelDialog.editing)
              store.updateModel(
                selected.id,
                modelDialog.editing.id,
                draft
              );
            else
              store.addModel(selected.id, draft);
          }}
          onClose={() => setModelDialog(null)}
        />
      )}
    </div>
  );
}
