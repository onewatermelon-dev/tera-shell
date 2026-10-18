import { Switch } from "@heroui/react";

type Props = {
  isSelected: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  /** 禁用态：保留开关及其标签的可见性（隐藏会让人以为选项不存在） */
  isDisabled?: boolean;
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
  ariaLabel,
  isDisabled
}: Props) {
  return (
    <Switch
      aria-label={ariaLabel}
      isSelected={isSelected}
      isDisabled={isDisabled}
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
