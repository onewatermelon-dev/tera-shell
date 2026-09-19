import { invoke } from "@tauri-apps/api/core";

/**
 * 应用数据的读写层。
 *
 * 磁盘是唯一真相，但**读是同步的** —— 启动时一次性把全部数据读进内存，
 * 之后各处的 `readData` 直接命中缓存。这样原先 localStorage 那套同步语义
 * 得以保留，会话 / 设置 / 快捷宏的组件代码一行都不用改。
 *
 * 写则是「内存先行、异步落盘」：改完立刻可见，磁盘失败只记日志，
 * 不打断用户操作（存储失败不该让人用不了应用）。
 */
const cache = new Map<string, string>();

/** 逻辑数据名。与后端 `data.rs` 的白名单一一对应。 */
export const DataName = {
  sessions: "sessions",
  settings: "settings",
  macros: "macros"
} as const;

/**
 * 启动时调用：把磁盘上的全部数据读进内存。
 *
 * 读失败按空数据继续 —— 首次启动本来就没有文件，
 * 不能因此让应用打不开。
 */
export async function initStorage(): Promise<void> {
  try {
    const all =
      await invoke<Record<string, string>>(
        "load_all"
      );
    for (const [name, payload] of Object.entries(
      all
    )) {
      cache.set(name, payload);
    }
  } catch (reason) {
    console.error("读取本地数据失败", reason);
  }
}

/** 同步读取一份数据；没有则返回 null。 */
export function readData(
  name: string
): string | null {
  return cache.get(name) ?? null;
}

/** 写入一份数据：内存立即生效，磁盘异步跟上。 */
export function writeData(
  name: string,
  payload: string
): void {
  cache.set(name, payload);
  invoke("save_one", { name, payload }).catch(
    (reason: unknown) => {
      console.error("保存本地数据失败", reason);
    }
  );
}

/** 清掉一份数据（内存 + 磁盘）。 */
export function clearData(name: string): void {
  cache.delete(name);
  writeData(name, "null");
}
