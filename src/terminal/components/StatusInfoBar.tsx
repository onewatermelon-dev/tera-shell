import { useT } from "@/settings/lib/i18n";
import {
  InfoCircleOutlined,
  ClusterOutlined,
  WifiOutlined,
  ClockCircleOutlined
} from "@ant-design/icons";

type StatusInfoBarProps = {
  /** 点击尚未实现的入口（进程 / 网络信息）时的提示出口。 */
  onNotify: (message: string) => void;
  /** 打开「系统信息」抽屉；仅 SSH 会话激活时提供，否则退化为提示。 */
  onOpenSystem?: () => void;
};

/**
 * 底部状态栏的「信息」形态：左侧是系统 / 进程 / 网络信息入口与运行时长，
 * 右侧的负载、网络速度取代宏形态下的 LOCAL / UTF-8 / 尺寸。
 *
 * ponytail: 负载 / 网速 / 运行时长先以 -- 占位 —— 后端还没有 SSH exec 通道
 * （终端走系统 ssh 进程），接通后在这里填真实值。
 */
export default function StatusInfoBar({
  onNotify,
  onOpenSystem
}: StatusInfoBarProps) {
  const t = useT();
  const pending = [
    "status.info.system",
    "status.info.process",
    "status.info.network"
  ] as const;
  return (
    <>
      <div className="status-info">
        {pending.map(key => (
          <button
            key={key}
            type="button"
            className="status-info-btn"
            onClick={() => {
              if (
                key === "status.info.system" &&
                onOpenSystem
              ) {
                onOpenSystem();
                return;
              }
              onNotify(t("status.notReady"));
            }}
          >
            {key === "status.info.system" && (
              <InfoCircleOutlined />
            )}
            {key === "status.info.process" && (
              <ClusterOutlined />
            )}
            {key === "status.info.network" && (
              <WifiOutlined />
            )}
            {t(key)}
          </button>
        ))}
        <span className="status-info-btn is-static">
          <ClockCircleOutlined />
          {t("status.info.run")}: --
        </span>
      </div>
      <div className="status-meta">
        <span>
          {t("status.info.load")}: --/--/--
        </span>
        <span>
          {t("status.info.net")}: ↓--/↑--
        </span>
      </div>
    </>
  );
}
