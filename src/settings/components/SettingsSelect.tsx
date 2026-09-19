import type { ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { DownOutlined } from "@ant-design/icons";

/** 下拉里的一项。 */
export type SelectOption<T extends string> = {
  value: T;
  label: string;
  icon: ReactNode;
};

type SettingsSelectProps<T extends string> = {
  value: T;
  options: SelectOption<T>[];
  /** 无障碍标签，同时作为菜单的 aria-label */
  ariaLabel: string;
  onChange: (value: T) => void;
};

/**
 * 设置页通用的下拉框（主题、界面语言都用它）。
 *
 * 用 HeroUI Dropdown 而不是原生 `<select>`：原生下拉的 `<option>` 由系统
 * 绘制，**既塞不进图标、也改不了样式**，只有自绘才能做到和设置页一致的外观。
 *
 * 触发器显示当前选中项的图标 —— 比只显示文字更直观。
 *
 * ⚠️ 触发器必须是 `Dropdown.Trigger` 的直接子元素，不能在外面套 Tooltip ——
 * RAC 会找不到 pressable child，菜单打不开（终端标签栏那里踩过同样的坑）。
 */
export default function SettingsSelect<
  T extends string
>({
  value,
  options,
  ariaLabel,
  onChange
}: SettingsSelectProps<T>) {
  // 值非法时退回第一项，避免触发器渲染成空白
  const current =
    options.find(
      option => option.value === value
    ) ?? options[0];

  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className="settings-select"
        aria-label={`${ariaLabel}：${current?.label ?? ""}`}
      >
        <span className="settings-select-icon">
          {current?.icon}
        </span>
        <span className="settings-select-label">
          {current?.label}
        </span>
        <DownOutlined className="settings-select-caret" />
      </Dropdown.Trigger>
      <Dropdown.Popover
        placement="bottom end"
        className="settings-select-menu"
      >
        <Dropdown.Menu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={[value]}
          onAction={key => onChange(key as T)}
        >
          {options.map(option => (
            <Dropdown.Item
              key={option.value}
              id={option.value}
              textValue={option.label}
            >
              <span className="settings-select-item-icon">
                {option.icon}
              </span>
              <span>{option.label}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
