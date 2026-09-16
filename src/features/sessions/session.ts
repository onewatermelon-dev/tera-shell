export type SavedSession = {
  id: string;
  name: string;
  kind: "local" | "ssh";
  host: string;
  port: number;
  username: string;
  /** DPAPI 加密后的密码密文（base64），未保存过则为空。 */
  password?: string;
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
