import type { ColorTag } from "@/sessions/lib/sessionGroup";

export type SavedSession = {
  id: string;
  name: string;
  kind: "local" | "ssh";
  host: string;
  port: number;
  username: string;
  /** DPAPI 加密后的密码密文（base64），未保存过则为空。 */
  password?: string;
  /** 所属分组 id（见 sessionGroup.ts）；空串 / 缺省 = 未分组。 */
  groupId?: string;
  /** 颜色标记，用于侧栏色条快速区分环境。 */
  color?: ColorTag;
};

export const localSession: SavedSession = {
  id: "local",
  name: "本地 PowerShell",
  kind: "local",
  host: "localhost",
  port: 0,
  username: ""
};

export const emptySshSession =
  (): SavedSession => ({
    id: "",
    name: "",
    kind: "ssh",
    host: "",
    port: 22,
    username: ""
  });
