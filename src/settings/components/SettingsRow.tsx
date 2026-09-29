import type { ReactNode } from "react";

type SettingsRowProps = {
  title: string;
  description: string;
  /** 标题后面追加的说明（如当前配色方案名），弱色显示 */
  titleExtra?: ReactNode;
  /** 右上角控件：保存按钮、下拉框等 */
  control?: ReactNode;
  /** 卡片下方整宽内容：输入框等 */
  children?: ReactNode;
};

/**
 * 设置页里的一项配置（卡片形态）。
 *
 * 结构对齐参考图：上排是「标题+说明」靠左、控件靠右；下排可选，
 * 放需要整宽的输入框。文字块用 flex:1 占满剩余宽度，控件固定不收缩。
 */
export default function SettingsRow({
  title,
  description,
  titleExtra,
  control,
  children
}: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-head">
        <div className="settings-row-text">
          <p className="settings-row-title">
            {title}
            {titleExtra && (
              <span className="settings-row-title-extra">
                {titleExtra}
              </span>
            )}
          </p>
          <p className="settings-row-desc">
            {description}
          </p>
        </div>
        {control && (
          <div className="settings-row-control">
            {control}
          </div>
        )}
      </div>
      {children && (
        <div className="settings-row-body">
          {children}
        </div>
      )}
    </div>
  );
}
