import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { SavedSession } from "@/domain/session";

export type OpenSession = SavedSession & {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  mounted: boolean;
};

export function useTerminals(onError: (reason: unknown) => void) {
  const opened = reactive<OpenSession[]>([]);
  const activeId = ref("");
  const terminalHost = ref<HTMLElement>();
  const active = computed(() => opened.find(session => session.id === activeId.value));
  let unlisteners: UnlistenFn[] = [];
  let resizeObserver: ResizeObserver | undefined;

  async function open(session: SavedSession) {
    let current = opened.find(item => item.id === session.id);
    if (!current) {
      current = createTerminal(session);
      opened.push(current);
      try {
        await invoke("terminal_start", { config: session });
      } catch (reason) {
        opened.splice(opened.indexOf(current), 1);
        onError(reason);
        return;
      }
    }
    activeId.value = session.id;
    await mountActive();
  }

  function createTerminal(session: SavedSession): OpenSession {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: { background: "#0b0e14", foreground: "#c9d1d9", cursor: "#6ee7b7", selectionBackground: "#2f4f46" }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new SearchAddon());
    terminal.onData(data => invoke("terminal_write", { id: session.id, data }).catch(onError));
    return { ...session, terminal, fit, element: document.createElement("div"), mounted: false };
  }

  async function activate(id: string) {
    activeId.value = id;
    await mountActive();
  }

  async function mountActive() {
    await nextTick();
    const current = active.value;
    if (!current || !terminalHost.value) return;
    current.element.className = "terminal-instance";
    terminalHost.value.replaceChildren(current.element);
    if (!current.mounted) {
      current.terminal.open(current.element);
      current.mounted = true;
    }
    resizeObserver?.observe(terminalHost.value);
    resize(current);
    current.terminal.focus();
  }

  function resize(current = active.value) {
    if (!current) return;
    current.fit.fit();
    invoke("terminal_resize", {
      id: current.id,
      rows: current.terminal.rows,
      cols: current.terminal.cols
    }).catch(() => {});
  }

  async function close(id: string) {
    const index = opened.findIndex(session => session.id === id);
    if (index < 0) return;
    await invoke("terminal_close", { id }).catch(onError);
    opened[index]?.terminal.dispose();
    opened.splice(index, 1);
    if (activeId.value === id) activeId.value = opened[Math.max(0, index - 1)]?.id || "";
    await mountActive();
  }

  onMounted(async () => {
    unlisteners = await Promise.all([
      listen<{
        id: string;
        data: string;
      }>("terminal-output", ({ payload }) => opened.find(({ id }) => id === payload.id)?.terminal.write(payload.data)),
      listen<string>("terminal-exit", ({ payload }) =>
        opened.find(({ id }) => id === payload)?.terminal.write("\r\n\x1b[38;5;244m[会话已结束]\x1b[0m\r\n")
      )
    ]);
    resizeObserver = new ResizeObserver(() => resize());
  });

  onBeforeUnmount(() => {
    unlisteners.forEach(unlisten => unlisten());
    resizeObserver?.disconnect();
  });

  return { opened, activeId, active, terminalHost, open, activate, close };
}
