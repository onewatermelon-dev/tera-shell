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

  /** 拖拽换位：把 id 插到 beforeId 之前，beforeId 为 null 表示挪到末尾
   *  （与标签换位 reorderTab 同一套语义）。 */
  const reorder = useCallback(
    (id: string, beforeId: string | null) => {
      setMacros(prev => {
        const from = prev.findIndex(
          macro => macro.id === id
        );
        if (from < 0) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        // splice 返回值在 noUncheckedIndexedAccess 下是 T | undefined
        if (!moved) return prev;
        const to =
          beforeId === null
            ? next.length
            : next.findIndex(
                macro => macro.id === beforeId
              );
        if (to < 0) return prev;
        next.splice(to, 0, moved);
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
    reorder,
    reset
  };
}
