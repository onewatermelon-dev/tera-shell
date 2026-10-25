import { useState } from "react";
import {
  Button,
  Form,
  Input,
  Modal,
  TextField,
  Typography
} from "@heroui/react";
import type { SavedSession } from "@/sessions/lib/session";
import { useT } from "@/settings/lib/i18n";
import Toggle from "@/shared/components/Toggle";
import {
  assertReadOnly,
  isSafeWord
} from "@/watch/lib/watchChecks";
import WatchAlertRow from "@/watch/components/WatchAlertRow";
import { buildRecordDiagnosis } from "@/watch/lib/watchDiagnosis";
import {
  configOf,
  loadWatchFile,
  saveWatchFile,
  upsertConfig
} from "@/watch/lib/watchStore";
import {
  MIN_WATCH_INTERVAL_SEC,
  defaultConfig,
  type WatchAlertRecord,
  type WatchCheck,
  type WatchCheckKind,
  type WatchConfig,
  type WatchFile
} from "@/watch/lib/watchTypes";

type Props = {
  /** 要配置的会话（只挂载时传入，卸载即关闭） */
  session: SavedSession;
  onClose: () => void;
  /** 保存成功后通知外层刷新调度（不传表示只要落盘） */
  onSaved?: () => void;
  /**
   * 把归因文本送进 AI 面板；返回 false = 发不出去（本地会话等）。
   *
   * 与右侧面板同一个出口：AI 面板挂在当前活动终端上，必要时得先开终端。
   */
  onAskAi: (
    text: string,
    sessionId: string
  ) => boolean;
  /** 删除一条告警历史（由 App 注入，与右侧面板共用同一份数据） */
  onDeleteAlert: (id: string) => void;
};

/** 检查项的固定展示顺序：常用指标在前，自定义命令垫底。 */
const KINDS: WatchCheckKind[] = [
  "cpu",
  "mem",
  "disk",
  "load",
  "service",
  "command"
];

/**
 * 单会话的值守配置弹窗。
 *
 * ## 为什么配置挂在会话上而不是「一个全局巡检列表」
 *
 * 阈值天然是**按机器**的：同一条 85% 的磁盘线，在日志机上天天报警，
 * 在数据库机上早就该清了。挂在会话上还有个好处 —— 会话删了，配置跟着
 * 失去意义（启动时会顺手清掉孤儿配置）。
 *
 * ## 为什么只读校验放在提交时，而不是输入时就拦
 *
 * 边打边校验会在用户敲到 `df -` 时就冒红字（还没写完），体验很差。
 * 提交时统一拦截，并明确指出是哪一段触发的。
 */
export default function WatchDialog({
  session,
  onClose,
  onSaved,
  onAskAi,
  onDeleteAlert
}: Props) {
  const t = useT();
  // 挂载时读一次：弹窗生命周期内以本地状态为准，取消即丢弃
  const [file, setFile] = useState<WatchFile>(
    () => loadWatchFile()
  );
  const [config, setConfig] =
    useState<WatchConfig>(
      () =>
        configOf(file, session.id) ??
        defaultConfig(session.id)
    );
  const [error, setError] = useState("");
  /**
   * 「已发给 AI」的提示。
   *
   * 弹窗是模态层，AI 面板同样被压在下面 —— 但这里**不自动关闭**，
   * 因为用户可能正在改检查项，关掉就把未保存的编辑丢了。改成一行提示，
   * 让他自己关（与右侧面板的行为不同，那边关掉没有副作用）。
   */
  const [sentHint, setSentHint] = useState("");

  /**
   * 巡检关闭时，下面所有「怎么盯」的配置一律禁用。
   *
   * 关着还允许勾检查项是个假的自由度：配完了照样不会跑，用户会以为
   * 「我配了却没生效」，然后去怀疑心跳、怀疑网络 —— 实际只是总闸没开。
   * 这里选择**禁用而不是隐藏**：值要留着，下次打开开关原样恢复，
   * 用户也能看见自己之前配了什么。
   *
   * ⚠️ 保存/取消不在此列（否则连「关闭」这个状态都存不下来），
   * 全局的免打扰与历史告警也不在此列（它们不属于这个会话的开关）。
   */
  const idle = !config.enabled;

  /** 改单个检查项（按类型定位，类型唯一）。 */
  function patchCheck(
    kind: WatchCheckKind,
    patch: Partial<WatchCheck>
  ) {
    setConfig(current => ({
      ...current,
      checks: current.checks.map(check =>
        check.kind === kind
          ? { ...check, ...patch }
          : check
      )
    }));
  }

  /** 提交前的校验；返回错误文案，null 表示通过。 */
  function validate(): string | null {
    if (
      config.enabled &&
      !config.checks.some(check => check.enabled)
    )
      return t("watch.error.noCheck");
    for (const check of config.checks) {
      if (!check.enabled) continue;
      if (check.kind === "service") {
        const unit = (check.unit ?? "").trim();
        if (!unit)
          return t("watch.error.unitRequired");
        // 与脚本层的清洗规则一致：这些字符之外的单元名会被直接丢弃，
        // 在这里先拦下来，免得用户以为「配了但没生效」
        if (!isSafeWord(unit))
          return t("watch.error.unitInvalid");
      }
      if (check.kind === "command") {
        const reject = assertReadOnly(
          check.command ?? ""
        );
        if (reject) return reject;
      }
    }
    return null;
  }

  /**
   * 事后归因：把这条历史记录交给 AI 面板。
   *
   * 只在用户**主动点**的时候发生 —— 巡检本身绝不调模型，这是整套值守
   * 不烧 token 的前提。本地会话没有 AI 面板，返回 false 时给个明确提示，
   * 而不是「点了没反应」。
   */
  function askAi(record: WatchAlertRecord) {
    const sent = onAskAi(
      buildRecordDiagnosis(record),
      record.sessionId
    );
    if (!sent) {
      setError(t("watch.aiUnavailable"));
      return;
    }
    setError("");
    setSentHint(t("watch.aiSent"));
    console.info(
      `[watch] 已把告警 ${record.id} 交给 AI 归因`
    );
  }

  /**
   * 删除一条告警历史。
   *
   * 只从存储里刷新 `alerts` 这一片，**不能**整体 `setFile(loadWatchFile())` ——
   * 那会把用户还没保存的免打扰/冷却编辑一起冲掉。
   */
  function deleteAlert(record: WatchAlertRecord) {
    onDeleteAlert(record.id);
    setFile(current => ({
      ...current,
      alerts: loadWatchFile().alerts
    }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    const next = upsertConfig(file, {
      ...config,
      intervalSec: Math.max(
        MIN_WATCH_INTERVAL_SEC,
        Math.round(config.intervalSec || 0)
      )
    });
    saveWatchFile(next);
    console.info(
      `[watch] 已保存会话 ${session.id} 的巡检配置（启用 ${config.enabled}，间隔 ${config.intervalSec}s）`
    );
    onSaved?.();
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
        <Modal.Container placement="center">
          <Modal.Dialog className="watch-dialog">
            <Form onSubmit={submit}>
              <Modal.Header>
                <Typography.Paragraph
                  size="sm"
                  className="dialog-eyebrow"
                >
                  {t("watch.eyebrow")}
                </Typography.Paragraph>
                <Modal.Heading>
                  {t("watch.title")}
                </Modal.Heading>
                <Modal.CloseTrigger
                  aria-label={t(
                    "app.action.close"
                  )}
                />
              </Modal.Header>
              <Modal.Body>
                {/* 字段区自己滚，与 SessionDialog 完全一致的一套写法。
                    ⚠️ 别改成「让滚动区 flex 撑满 Modal.Body 剩余高度」：
                    弹窗里这层 `<Form>` 渲染出来是**裸 form**（block 元素），
                    不是 flex 容器，`flex: 1` 在其中不生效 —— 那样写的结果
                    是高度不受限、滚动条不出现，比不写更糟。
                    真正的机制是 `.dialog-scroll` 自带 max-height。 */}
                <div className="dialog-scroll">
                  <p className="watch-summary">
                    {session.name}
                    {session.kind === "local"
                      ? t(
                          "watch.localUnsupported"
                        )
                      : ` · ${session.username ? session.username + "@" : ""}${session.host}`}
                  </p>

                  <div className="watch-switch">
                    <Toggle
                      ariaLabel={t(
                        "watch.enable"
                      )}
                      isSelected={config.enabled}
                      onChange={enabled =>
                        setConfig({
                          ...config,
                          enabled
                        })
                      }
                    />
                    <span>
                      {t("watch.enable")}
                    </span>
                  </div>

                  {/* 常驻一行说明（开着/关着都占位）：切换时布局不跳，
                      也顺手解释了「为什么下面灰了」 */}
                  <p className="watch-hint">
                    {idle
                      ? t("watch.hint.off")
                      : t("watch.hint.on")}
                  </p>

                  <div className="watch-interval">
                    <TextField
                      className="watch-num"
                      isDisabled={idle}
                      value={String(
                        config.intervalSec
                      )}
                      onChange={value =>
                        setConfig({
                          ...config,
                          intervalSec:
                            Number(value) || 0
                        })
                      }
                    >
                      <Input
                        type="number"
                        min={
                          MIN_WATCH_INTERVAL_SEC
                        }
                        max={3600}
                        autoComplete="off"
                        aria-label={t(
                          "watch.interval"
                        )}
                        placeholder={t(
                          "watch.interval"
                        )}
                      />
                    </TextField>
                    <span className="watch-hint">
                      {t("watch.intervalHint")}
                    </span>
                  </div>

                  <div
                    className={
                      idle
                        ? "watch-checks is-idle"
                        : "watch-checks"
                    }
                  >
                    {/* 列名：两列数字光靠 placeholder 解释不了 ——
                        填了值 placeholder 就消失，用户只能靠猜 */}
                    <div
                      className="watch-checks-head"
                      aria-hidden="true"
                    >
                      <span />
                      <span />
                      <span className="watch-col">
                        {t("watch.threshold")}
                      </span>
                      <span className="watch-col">
                        {t("watch.consecutive")}
                      </span>
                    </div>
                    <p className="watch-hint">
                      {t("watch.checksHint")}
                    </p>
                    {KINDS.map(kind => {
                      const check =
                        config.checks.find(
                          item =>
                            item.kind === kind
                        );
                      if (!check) return null;
                      return (
                        <div
                          className={
                            check.enabled
                              ? "watch-check is-on"
                              : "watch-check"
                          }
                          key={kind}
                        >
                          <div className="watch-check-head">
                            <Toggle
                              ariaLabel={t(
                                `watch.kind.${kind}`
                              )}
                              isSelected={
                                check.enabled
                              }
                              isDisabled={idle}
                              onChange={enabled =>
                                patchCheck(kind, {
                                  enabled
                                })
                              }
                            />
                            <span className="watch-check-name">
                              {t(
                                `watch.kind.${kind}`
                              )}
                            </span>
                            {kind === "service" ||
                            kind === "command" ? (
                              // 这两类没有百分比阈值：留个破折号占位，
                              // 否则那一格空着会被看成「漏配了」
                              <span
                                className="watch-col watch-col-none"
                                title={t(
                                  "watch.noThreshold"
                                )}
                              >
                                —
                              </span>
                            ) : (
                              <TextField
                                className="watch-num"
                                isDisabled={idle}
                                value={String(
                                  check.threshold
                                )}
                                onChange={value =>
                                  patchCheck(
                                    kind,
                                    {
                                      threshold:
                                        Number(
                                          value
                                        ) || 0
                                    }
                                  )
                                }
                              >
                                <Input
                                  type="number"
                                  min={0}
                                  step={
                                    kind ===
                                    "load"
                                      ? 0.1
                                      : 1
                                  }
                                  autoComplete="off"
                                  aria-label={`${t(
                                    `watch.kind.${kind}`
                                  )} ${t("watch.threshold")}`}
                                  placeholder={t(
                                    "watch.threshold"
                                  )}
                                />
                              </TextField>
                            )}
                            <TextField
                              className="watch-num"
                              isDisabled={idle}
                              value={String(
                                check.consecutive
                              )}
                              onChange={value =>
                                patchCheck(kind, {
                                  consecutive:
                                    Number(
                                      value
                                    ) || 1
                                })
                              }
                            >
                              <Input
                                type="number"
                                min={1}
                                max={60}
                                autoComplete="off"
                                aria-label={`${t(
                                  `watch.kind.${kind}`
                                )} ${t("watch.consecutive")}`}
                                placeholder={t(
                                  "watch.consecutive"
                                )}
                              />
                            </TextField>
                          </div>
                          {kind === "disk" && (
                            <div className="watch-extra">
                              <span className="watch-field-label">
                                {t(
                                  "watch.label.mount"
                                )}
                              </span>
                              <TextField
                                className="watch-extra-field"
                                isDisabled={idle}
                                value={
                                  check.mount ??
                                  "/"
                                }
                                onChange={value =>
                                  patchCheck(
                                    kind,
                                    {
                                      mount: value
                                    }
                                  )
                                }
                              >
                                <Input
                                  autoComplete="off"
                                  aria-label={t(
                                    "watch.mount"
                                  )}
                                  placeholder="/"
                                />
                              </TextField>
                            </div>
                          )}
                          {kind === "service" && (
                            <div className="watch-extra">
                              <span className="watch-field-label">
                                {t(
                                  "watch.label.unit"
                                )}
                              </span>
                              <TextField
                                className="watch-extra-field"
                                isDisabled={idle}
                                value={
                                  check.unit ?? ""
                                }
                                onChange={value =>
                                  patchCheck(
                                    kind,
                                    {
                                      unit: value
                                    }
                                  )
                                }
                              >
                                <Input
                                  autoComplete="off"
                                  aria-label={t(
                                    "watch.unit"
                                  )}
                                  placeholder="nginx"
                                />
                              </TextField>
                            </div>
                          )}
                          {kind === "command" && (
                            <>
                              <div className="watch-extra">
                                <span className="watch-field-label">
                                  {t(
                                    "watch.label.command"
                                  )}
                                </span>
                                <TextField
                                  className="watch-extra-field"
                                  isDisabled={
                                    idle
                                  }
                                  value={
                                    check.command ??
                                    ""
                                  }
                                  onChange={value =>
                                    patchCheck(
                                      kind,
                                      {
                                        command:
                                          value
                                      }
                                    )
                                  }
                                >
                                  <Input
                                    autoComplete="off"
                                    aria-label={t(
                                      "watch.command"
                                    )}
                                    placeholder="uptime"
                                  />
                                </TextField>
                              </div>
                              <div className="watch-extra">
                                <span className="watch-field-label">
                                  {t(
                                    "watch.label.expect"
                                  )}
                                </span>
                                <TextField
                                  className="watch-extra-field"
                                  isDisabled={
                                    idle
                                  }
                                  value={
                                    check.expect ??
                                    ""
                                  }
                                  onChange={value =>
                                    patchCheck(
                                      kind,
                                      {
                                        expect:
                                          value
                                      }
                                    )
                                  }
                                >
                                  <Input
                                    autoComplete="off"
                                    aria-label={t(
                                      "watch.expect"
                                    )}
                                    placeholder={t(
                                      "watch.optional"
                                    )}
                                  />
                                </TextField>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <p className="watch-hint">
                    {t("watch.commandHint")}
                  </p>

                  <div className="watch-global">
                    <span className="watch-global-title">
                      {t("watch.quietTitle")}
                    </span>
                    <div className="watch-quiet">
                      <TextField
                        className="watch-num"
                        value={file.quiet.start}
                        onChange={value =>
                          setFile({
                            ...file,
                            quiet: {
                              ...file.quiet,
                              start: value
                            }
                          })
                        }
                      >
                        <Input
                          autoComplete="off"
                          aria-label={t(
                            "watch.quietStart"
                          )}
                          placeholder="23:00"
                        />
                      </TextField>
                      <span>~</span>
                      <TextField
                        className="watch-num"
                        value={file.quiet.end}
                        onChange={value =>
                          setFile({
                            ...file,
                            quiet: {
                              ...file.quiet,
                              end: value
                            }
                          })
                        }
                      >
                        <Input
                          autoComplete="off"
                          aria-label={t(
                            "watch.quietEnd"
                          )}
                          placeholder="08:00"
                        />
                      </TextField>
                      <TextField
                        className="watch-num"
                        value={String(
                          file.cooldownMin
                        )}
                        onChange={value =>
                          setFile({
                            ...file,
                            cooldownMin:
                              Number(value) || 1
                          })
                        }
                      >
                        <Input
                          type="number"
                          min={1}
                          max={1440}
                          autoComplete="off"
                          aria-label={t(
                            "watch.cooldown"
                          )}
                          placeholder={t(
                            "watch.cooldown"
                          )}
                        />
                      </TextField>
                    </div>
                    <p className="watch-hint">
                      {t("watch.quietHint")}
                    </p>
                  </div>

                  <div className="watch-global">
                    <span className="watch-global-title">
                      {t("watch.recentAlerts")}
                    </span>
                    {file.alerts.filter(
                      record =>
                        record.sessionId ===
                        session.id
                    ).length === 0 ? (
                      <p className="watch-hint">
                        {t("watch.noAlerts")}
                      </p>
                    ) : (
                      file.alerts
                        .filter(
                          record =>
                            record.sessionId ===
                            session.id
                        )
                        .slice(0, 5)
                        .map(record => (
                          <WatchAlertRow
                            key={record.id}
                            record={record}
                            onAskAi={askAi}
                            onDelete={deleteAlert}
                            showSession={false}
                          />
                        ))
                    )}
                  </div>

                  {sentHint && (
                    <p className="watch-hint">
                      {sentHint}
                    </p>
                  )}

                  {error && (
                    <Typography.Paragraph
                      size="sm"
                      className="dialog-error"
                    >
                      {error}
                    </Typography.Paragraph>
                  )}
                </div>
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
                  type="submit"
                >
                  {t("common.save")}
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
