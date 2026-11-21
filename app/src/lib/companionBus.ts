/**
 * Event bridge between the main window and the desktop companion (the
 * "overlay" window). Each window has its own store, so the main window tells
 * the companion when its chats start/stop working, and the companion asks the
 * main window to open a chat.
 */
import { useApp } from "./store";

// shortcut: the companion is hidden until it's finished (opaque window, can't type to it, card too big); flip to true to work on it. Mirrors COMPANION_ENABLED in main.rs.
export const COMPANION_ENABLED = false;

/** localStorage: "off" hides the companion; the crew member it shows. */
export const COMPANION_KEY = "zwork:companion";
export const COMPANION_CREW_KEY = "zwork:companion-crew";

/** Settings side: show or hide the companion and pick who it is. */
export async function configureCompanion(on: boolean, crewId: string) {
  localStorage.setItem(COMPANION_KEY, on ? "on" : "off");
  localStorage.setItem(COMPANION_CREW_KEY, crewId);
  const [{ WebviewWindow }, { emitTo }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/event"),
  ]);
  const w = await WebviewWindow.getByLabel("overlay");
  // The crew id rides along: localStorage writes aren't guaranteed to reach the other webview at once.
  await emitTo("overlay", "companion:config", { crewId }).catch(() => {});
  await (on ? w?.show() : w?.hide())?.catch(() => {});
}

export type TaskDone = { id: string; title: string; snippet: string; failed: boolean };

const plain = (md: string) => md.replace(/[#*_`>[\]()!-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);

/** Watch this window's chats: `onWorking` on any-chat-working flips, `onDone` when a run ends. */
export function watchChats(onWorking: (working: boolean) => void, onDone: (d: TaskDone) => void) {
  const prev = new Map<string, boolean>();
  let prevAny: boolean | null = null;
  const check = (s: ReturnType<typeof useApp.getState>) => {
    let any = false;
    for (const c of Object.values(s.chats)) {
      const w = !!c.working;
      if (w) any = true;
      if (prev.get(c.id) && !w) {
        const last = [...c.messages].reverse().find((m) => m.role === "assistant");
        onDone({ id: c.id, title: c.title || "Your task", snippet: plain(last?.content ?? ""), failed: !!c.error });
      }
      prev.set(c.id, w);
    }
    if (any !== prevAny) {
      prevAny = any;
      onWorking(any);
    }
  };
  check(useApp.getState());
  return useApp.subscribe(check);
}

/** Main window side: forward chat activity to the companion and open chats it asks for. */
export function startCompanionBridge(): () => void {
  let unlisten: (() => void) | undefined;
  let stopped = false;
  let stopWatch = () => {};
  void import("@tauri-apps/api/event").then(({ emitTo, listen }) => {
    if (stopped) return;
    stopWatch = watchChats(
      (working) => void emitTo("overlay", "companion:working", working).catch(() => {}),
      (d) => {
        // You're looking at that chat already; a desktop note would be noise.
        if (document.hasFocus() && useApp.getState().activeChatId === d.id) return;
        void emitTo("overlay", "companion:task-done", d).catch(() => {});
      },
    );
    void listen<{ id: string }>("companion:open-chat", async (e) => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.unminimize().catch(() => {});
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
      await useApp.getState().refreshChats();
      if (e.payload?.id) await useApp.getState().openChat(e.payload.id);
    }).then((u) => (stopped ? u() : (unlisten = u)));
  });
  return () => {
    stopped = true;
    stopWatch();
    unlisten?.();
  };
}
