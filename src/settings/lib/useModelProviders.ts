import { useCallback, useState } from "react";
import {
  createModelId,
  loadProviders,
  saveProviders,
  type ModelDraft,
  type ModelEntry,
  type ModelProvider
} from "@/settings/lib/modelProviders";

/** 供应商上可改的标量字段（id 与模型列表走各自的入口）。 */
type ProviderPatch = Partial<
  Omit<ModelProvider, "id" | "models">
>;

/**
 * 模型供应商的状态管理：增删改一处落盘（与 useMacros 同一套做法），
 * 组件只管调用，不必关心"什么时候保存"。
 */
export function useModelProviders() {
  const [providers, setProviders] = useState<
    ModelProvider[]
  >(loadProviders);

  /** 对最新列表跑 fn 并落盘；所有变更都走这一个口子。 */
  const mutate = useCallback(
    (
      fn: (
        prev: ModelProvider[]
      ) => ModelProvider[]
    ) => {
      setProviders(prev => {
        const next = fn(prev);
        saveProviders(next);
        return next;
      });
    },
    []
  );

  /** 新增一个空供应商并返回它（调用方拿 id 立刻选中）。 */
  const add = useCallback(
    (name: string): ModelProvider => {
      const provider: ModelProvider = {
        id: createModelId("provider"),
        name,
        baseUrl: "",
        apiFormat: "openai",
        apiKey: "",
        enabled: true,
        models: []
      };
      mutate(prev => [...prev, provider]);
      return provider;
    },
    [mutate]
  );

  /** 局部更新某只供应商的字段（改名、换地址、开关等）。 */
  const update = useCallback(
    (id: string, patch: ProviderPatch) => {
      mutate(prev =>
        prev.map(item =>
          item.id === id
            ? {
                ...item,
                ...patch
              }
            : item
        )
      );
    },
    [mutate]
  );

  /** 删除整只供应商（连同它的模型列表）。 */
  const remove = useCallback(
    (id: string) => {
      mutate(prev =>
        prev.filter(item => item.id !== id)
      );
    },
    [mutate]
  );

  /** 给供应商加一条模型（弹窗保存的草稿，id 在这里生成）。 */
  const addModel = useCallback(
    (providerId: string, draft: ModelDraft) => {
      mutate(prev =>
        prev.map(item =>
          item.id === providerId
            ? {
                ...item,
                models: [
                  ...item.models,
                  {
                    id: createModelId("model"),
                    ...draft
                  }
                ]
              }
            : item
        )
      );
    },
    [mutate]
  );

  /** 改一条模型的任意字段（行内开关、弹窗整份保存都走它）。 */
  const updateModel = useCallback(
    (
      providerId: string,
      modelId: string,
      patch: Partial<ModelEntry>
    ) => {
      mutate(prev =>
        prev.map(item =>
          item.id === providerId
            ? {
                ...item,
                models: item.models.map(model =>
                  model.id === modelId
                    ? {
                        ...model,
                        ...patch
                      }
                    : model
                )
              }
            : item
        )
      );
    },
    [mutate]
  );

  /** 删一条模型。 */
  const removeModel = useCallback(
    (providerId: string, modelId: string) => {
      mutate(prev =>
        prev.map(item =>
          item.id === providerId
            ? {
                ...item,
                models: item.models.filter(
                  model => model.id !== modelId
                )
              }
            : item
        )
      );
    },
    [mutate]
  );

  return {
    providers,
    add,
    update,
    remove,
    addModel,
    updateModel,
    removeModel
  };
}
