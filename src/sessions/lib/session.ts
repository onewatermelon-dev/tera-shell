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
  /**
   * 跳板机：指向另一个已保存 SSH 会话的 id，连接时经它 ProxyJump
   * （ssh -J）。多跳靠中间会话自己的 jumpHostId 串联，见 jumpHost.ts。
   *
   * 存 id 而非规格字符串：跳板的地址/端口/密码改了，这里自动跟上。
   * ⚠️ 不参与导出/导入 —— 导出文件不带 id（重导会重新生成），引用必然悬空。
   */
  jumpHostId?: string;
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
