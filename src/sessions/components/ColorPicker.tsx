import { useState } from "react";
import type { CSSProperties } from "react";
import {
  ColorArea,
  ColorField,
  ColorSlider,
  Label,
  ListBox,
  Select,
  // ⚠️ 必须改名导入：本地组件也叫 ColorPicker，同名会遮蔽 HeroUI 的，
  // 它的 .Trigger / .Popover 子组件就全变成 undefined
  ColorPicker as HeroColorPicker
} from "@heroui/react";
import {
  COLOR_TAGS,
  colorHex,
  isCustomColor,
  type ColorTag
} from "@/sessions/lib/sessionGroup";
import { useT } from "@/settings/lib/i18n";
import type { MessageKey } from "@/settings/lib/i18n";

type Props = {
  /** 当前颜色；空串 = 不标记。 */
  value: ColorTag;
  onChange: (value: ColorTag) => void;
};

/** 自定义取色器的初值：没有自定义色时给个醒目的蓝，避免开局是黑。 */
const DEFAULT_CUSTOM = "#3b82f6";

/**
 * 色彩空间及其对应通道。
 *
 * ⚠️ 通道名是**字面量联合**（"hue" | "saturation" | …），而它的类型
 * ColorChannel 定义在 react-aria-components 里 —— 那不是本项目的直接依赖，
 * 写 `Record<ColorSpace, ColorChannel[]>` 就得 import 一个传递依赖。
 * 所以这里用 `as const` 让TS 自己推导出同样的字面量联合。
 */
const CHANNELS_BY_SPACE = {
  rgb: ["red", "green", "blue"],
  hsb: ["hue", "saturation", "brightness"],
  hsl: ["hue", "saturation", "lightness"]
} as const;

type ColorSpace = keyof typeof CHANNELS_BY_SPACE;
type ColorChannel =
  (typeof CHANNELS_BY_SPACE)[ColorSpace][number];

/**
 * 各通道的中文名。
 *
 * 显式标注 MessageKey：否则 TS 只会推成 string，`t()` 收窄成
 * 字面量联合的参数类型就报不上了。
 */
const CHANNEL_LABEL_KEYS: Record<
  ColorChannel,
  MessageKey
> = {
  blue: "colorTag.chBlue",
  brightness: "colorTag.chBrightness",
  green: "colorTag.chGreen",
  hue: "colorTag.chHue",
  lightness: "colorTag.chLightness",
  red: "colorTag.chRed",
  saturation: "colorTag.chSaturation"
};

/**
 * 颜色标记选择器：一排固定色点 + 末尾一个自由取色器。
 *
 * 固定色点用原生 radio —— 这一排要紧凑排布，原生 input 的同名互斥语义
 * 正好合适。末尾的自由取色用 HeroUI ColorPicker，面板结构照官方示例：
 * 取色区 + 色相滑杆 + 色彩空间选择 + 三个通道输入框。
 *
 * 取色**立即生效**：拖动过程中触发器里的甜甜圈就跟着变色。
 * 存的值统一是 hex 字符串（ColorTag 的一部分，见 sessionGroup.ts）。
 */
export default function ColorPicker({
  value,
  onChange
}: Props) {
  const t = useT();
  const [colorSpace, setColorSpace] =
    useState<ColorSpace>("rgb");

  /**
   * 弹层当前的颜色 = 已选的自定义色，没选过时给个初值。
   *
   * 不单独存draft：取色立即生效，每一步直接写回父组件，
   * 天然同步；多存一份反而会出现「面板里是这个色、触发器还是那个色」。
   */
  const current = isCustomColor(value)
    ? value
    : DEFAULT_CUSTOM;

  /**
   * 取到颜色就立刻写回。
   *
   * 参数类型交给调用处推断（HeroUI 传的是 react-stately 的 Color 对象，
   * ColorField 在清空时还会传 null）—— react-stately 不是直接依赖，
   * 不为这一个类型去import。
   */
  const applyColor = (
    color: {
      toString: (format?: "hex") => string;
    } | null
  ) => onChange(color?.toString("hex") ?? value);

  return (
    <div className="color-picker-row">
      <div
        className="color-swatches"
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
      <HeroColorPicker
        value={current}
        onChange={applyColor}
      >
        <HeroColorPicker.Trigger
          className="color-custom-trigger"
          style={
            isCustomColor(value)
              ? ({
                  "--trigger-color": value
                } as CSSProperties)
              : undefined
          }
          aria-label={t("colorTag.custom")}
        />
        <HeroColorPicker.Popover
          placement="bottom start"
          className="color-custom-popover"
        >
          <ColorArea
            className="color-custom-area"
            colorSpace="hsb"
            xChannel="saturation"
            yChannel="brightness"
          >
            <ColorArea.Thumb />
          </ColorArea>
          <ColorSlider
            channel="hue"
            colorSpace="hsb"
            className="color-custom-slider"
          >
            <Label>{t("colorTag.chHue")}</Label>
            <ColorSlider.Output className="color-custom-output" />
            <ColorSlider.Track>
              <ColorSlider.Thumb />
            </ColorSlider.Track>
          </ColorSlider>
          <Select
            aria-label={t("colorTag.colorSpace")}
            value={colorSpace}
            variant="secondary"
            className="color-custom-space"
            onChange={next =>
              setColorSpace(next as ColorSpace)
            }
          >
            <Select.Trigger>
              <Select.Value className="color-custom-space-value" />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(
                  Object.keys(
                    CHANNELS_BY_SPACE
                  ) as ColorSpace[]
                ).map(space => (
                  <ListBox.Item
                    key={space}
                    id={space}
                    textValue={space}
                    className="color-custom-space-item"
                  >
                    {space}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <div className="color-custom-fields">
            {CHANNELS_BY_SPACE[colorSpace].map(
              channel => (
                <ColorField
                  key={channel}
                  aria-label={t(
                    CHANNEL_LABEL_KEYS[channel]
                  )}
                  channel={channel}
                  colorSpace={colorSpace}
                >
                  <ColorField.Group variant="secondary">
                    <ColorField.Input />
                  </ColorField.Group>
                </ColorField>
              )
            )}
          </div>
        </HeroColorPicker.Popover>
      </HeroColorPicker>
    </div>
  );
}
