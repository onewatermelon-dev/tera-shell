import { useCallback, useState } from "react";
import {
  clearMacros,
  createMacroId,
  loadMacros,
  saveMacros,
  type TerminalMacro
} from "@/terminal/lib/terminalMacros";

/**
 * 快捷宏的状态管理：增删改一处落库，组件只管调用。
 *
 * 持久化是副作用而不是状态源，所以这里改动后立刻写回 localStorage，
 * 不让组件去关心"什么时候保存"。
 */
export function useMacros() {
  const [macros, setMacros] =
    useState<TerminalMacro[]>(loadMacros);

  /** 新增一条宏；名称留空时用命令首行兜底。 */
  const add = useCallback(
    (name: string, command: string) => {
      const trimmed = command.trim();
      if (!trimmed) return;
      setMacros(prev => {
        const next = [
          ...prev,
          {
            id: createMacroId(),
            name: name.trim() || trimmed,
            command: trimmed
          }
        ];
        saveMacros(next);
        return next;
      });
    },
    []
  );

  /** 修改一条宏；命令被清空则视为删除。 */
  const update = useCallback(
    (
      id: string,
      name: string,
      command: string
    ) => {
      const trimmed = command.trim();
      setMacros(prev => {
        const next = trimmed
          ? prev.map(macro =>
              macro.id === id
                ? {
                    ...macro,
                    name: name.trim() || trimmed,
                    command: trimmed
                  }
                : macro
            )
          : prev.filter(macro => macro.id !== id);
        saveMacros(next);
        return next;
      });
    },
    []
  );

  /** 删除一条宏。 */
  const remove = useCallback((id: string) => {
    setMacros(prev => {
      const next = prev.filter(
        macro => macro.id !== id
      );
      saveMacros(next);
      return next;
    });
  }, []);

  /** 调整顺序：把第 index 条往前/往后挪一位，越界则不动。 */
  const move = useCallback(
    (index: number, offset: number) => {
      setMacros(prev => {
        const target = index + offset;
        if (
          index < 0 ||
          index >= prev.length ||
          target < 0 ||
          target >= prev.length
        )
          return prev;
        const next = [...prev];
        const [moved] = next.splice(index, 1);
        // splice 的返回值在 noUncheckedIndexedAccess 下可能是 undefined
        if (!moved) return prev;
        next.splice(target, 0, moved);
        saveMacros(next);
        return next;
      });
    },
    []
  );

  /** 恢复成内置示例（管理面板里的"恢复默认"）。 */
  const reset = useCallback(() => {
    clearMacros();
    setMacros(loadMacros());
  }, []);

  return {
    macros,
    add,
    update,
    remove,
    move,
    reset
  };
}
