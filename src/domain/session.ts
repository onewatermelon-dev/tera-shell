export type SavedSession = {
  id: string;
  name: string;
  kind: "local" | "ssh";
  host: string;
  port: number;
  username: string;
};

export const localSession: SavedSession = {
  id: "local",
  name: "本地 PowerShell",
  kind: "local",
  host: "localhost",
  port: 0,
  username: ""
};

export const emptySshSession = (): SavedSession => ({
  id: "",
  name: "",
  kind: "ssh",
  host: "",
  port: 22,
  username: ""
});
