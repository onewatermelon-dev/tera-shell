import {
  COLOR_TAGS,
  colorHex,
  type ColorTag
} from "@/sessions/lib/sessionGroup";
import { useT } from "@/settings/lib/i18n";

type Props = {
  /** 当前颜色；空串 = 不标记。 */
  value: ColorTag;
  onChange: (value: ColorTag) => void;
};

/**
 * 颜色标记选择器：一排圆点，点一下就换色。
 *
 * 选中态用双环画（内环填色 + 外环描边），空色那一项是「⊘」——
 * 纯白圆点在浅色主题下会和背景糊在一起，看不出是不是色块。
 *
 * 用原生 radio 而不是 HeroUI 组件：这一排要紧凑排布且自带键盘可达，
 * 原生 input 的分组语义（同名 radio = 互斥）正好合适。
 */
export default function ColorPicker({
  value,
  onChange
}: Props) {
  const t = useT();

  return (
    <div
      className="color-picker"
      role="radiogroup"
      aria-label={t("colorTag.label")}
    >
      {COLOR_TAGS.map(tag => (
        <label
          key={tag.value || "none"}
          className={`color-dot${value === tag.value ? " is-active" : ""}`}
          style={{
            background: colorHex(tag.value)
          }}
        >
          <input
            type="radio"
            name="color-tag"
            className="color-dot-input"
            checked={value === tag.value}
            onChange={() => onChange(tag.value)}
            aria-label={t(
              tag.value
                ? `colorTag.${tag.value}`
                : "colorTag.none"
            )}
          />
        </label>
      ))}
    </div>
  );
}
