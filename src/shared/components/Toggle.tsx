import { Switch } from "@heroui/react";

type Props = {
  isSelected: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
};

/**
 * 纯开关（无文字标签）。
 *
 * HeroUI v3 的 Switch 只是 SwitchField 外壳，滑轨要自己塞
 * Content > Control > Thumb 才画得出来 —— 裸用等于渲染了个隐形控件。
 */
export default function Toggle({
  isSelected,
  onChange,
  ariaLabel
}: Props) {
  return (
    <Switch
      aria-label={ariaLabel}
      isSelected={isSelected}
      onChange={onChange}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}
