import { useCallback, useState } from "react";
import {
  DataName,
  readData,
  writeData
} from "@/settings/lib/storage";
import {
  emptyGroup,
  parseGroups,
  type SessionGroup
} from "@/sessions/lib/sessionGroup";

/**
 * 会话分组的增删改与折叠态。
 *
 * 分组数据独立存groups.json：会话只存groupId 引用，
 * 改分组名/颜色不必遍历改写每一条会话。
 */
export function useSessionGroups() {
  const [groups, setGroups] = useState<
    SessionGroup[]
  >(() => parseGroups(readData(DataName.groups)));

  const persist = useCallback(
    (next: SessionGroup[]) => {
      writeData(
        DataName.groups,
        JSON.stringify(next)
      );
    },
    []
  );

  /** 新建分组，返回新分组的 id（供调用方把选中会话挪进去）。 */
  const add = useCallback(
    (group: Partial<SessionGroup>) => {
      const created = {
        ...emptyGroup(),
        ...group
      };
      setGroups(prev => {
        const next = [...prev, created];
        persist(next);
        return next;
      });
      return created.id;
    },
    [persist]
  );

  /**
   * 改分组名 / 颜色。patch 只接受这两个字段 —— id 与 collapsed 分别由
   * 新建流程和 toggle 决定，从这里改会让调用方绕过状态机。
   */
  const update = useCallback(
    (
      id: string,
      patch: Partial<
        Pick<SessionGroup, "name" | "color">
      >
    ) => {
      setGroups(prev => {
        const index = prev.findIndex(
          item => item.id === id
        );
        const current = prev[index];
        if (!current) return prev;
        const next = [...prev];
        next[index] = { ...current, ...patch };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  /**
   * 删分组。**不会**顺手清会话的 groupId ——
   * 调用方（App）要同时跑 useSessions.unassignGroup，否则会话会指向空气。
   */
  const remove = useCallback(
    (id: string) => {
      setGroups(prev => {
        const next = prev.filter(
          item => item.id !== id
        );
        if (next.length === prev.length)
          return prev;
        persist(next);
        return next;
      });
    },
    [persist]
  );

  /**
   * 批量追加分组（会话导入用）。
   *
   * id 由 `parseImportPayload` 预先生成，且已与导入会话的 groupId 对应，
   * 所以这里**必须原样保留传入的 id**，不能像 `add()` 那样重新生成
   * ——否则会话会指向不存在的分组。一次写盘，别逐条调 `add()`。
   */
  const addMany = useCallback(
    (incoming: SessionGroup[]) => {
      if (incoming.length === 0) return;
      setGroups(prev => {
        const next = [...prev, ...incoming];
        persist(next);
        return next;
      });
    },
    [persist]
  );

  /** 折叠 / 展开切换。 */
  const toggle = useCallback(
    (id: string) => {
      setGroups(prev => {
        const next = prev.map(item =>
          item.id === id
            ? {
                ...item,
                collapsed: !item.collapsed
              }
            : item
        );
        persist(next);
        return next;
      });
    },
    [persist]
  );

  /** 全部展开 / 全部折叠（侧栏标题行的批量操作）。 */
  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      setGroups(prev => {
        const next = prev.map(item => ({
          ...item,
          collapsed
        }));
        persist(next);
        return next;
      });
    },
    [persist]
  );

  return {
    groups,
    add,
    addMany,
    update,
    remove,
    toggle,
    setAllCollapsed
  };
}
