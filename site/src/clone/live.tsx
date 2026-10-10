import { createContext, useContext } from "react";
import gsap from "gsap";
import { THINKING_WORDS } from "./engine";
import type { ArtifactKind, AssistantMsg, CloneState, Msg, Panel, ToolIcon, View } from "./types";

/**
 * The hands-on half of the desktop demo. Clicking into the clone stops the
 * scripted run where it is and hands the window to the visitor: the sidebar,
 * the chats in it, steps, documents, the model menu and the composer all
 * work, and anything sent gets a polite reply with a way to get the app.
 */

/** The conversation behind a sidebar entry. */
export type CannedChat = { prompt: string; time: string; steps: [string, ToolIcon][]; reply: string; footer: string };

type Saved = { title: string; messages: Msg[]; panel: Panel | null };

const REPLIES = [
  `I'd start on that right away, but this is only a preview running in your browser, so I can't reach your files from here.

**Ready for the real thing?** Get zWork, sign in with a free account and ask me again. I'll work on your real files and check with you before anything is sent.`,
  "Same answer, I'm afraid: this page is only a preview. In the app I'd get on with it.",
];

export type LiveApi = {
  nav(view: View): void;
  openChat(id: string): void;
  toggleSteps(id: string): void;
  openPanel(title: string, kind: ArtifactKind): void;
  closePanel(): void;
  type(text: string): void;
  focus(on: boolean): void;
  send(): void;
  toggleModels(): void;
  setModel(name: string): void;
  toggleTask(id: string): void;
  toggleInbox(id: string): void;
  dismissCta(id: string): void;
};

export class LiveSession implements LiveApi {
  private cur: CloneState;
  private chats = new Map<string, Saved>();
  private runs: gsap.core.Timeline[] = [];
  private sent = 0;
  private n = 0;

  constructor(
    start: CloneState,
    private commit: (s: CloneState) => void,
    private canned: Record<string, CannedChat>,
  ) {
    // Whatever the script was halfway through, land it.
    this.cur = {
      ...start,
      working: false,
      permission: null,
      pressed: null,
      modelMenu: false,
      messages: start.messages.map((m) =>
        m.role === "assistant" ? { ...m, working: false, streaming: false, steps: m.steps.map((st) => ({ ...st, done: true })) } : m,
      ),
      panel: start.panel && { ...start.panel, progress: 1 },
    };
    this.commit(this.cur);
  }

  dispose() {
    for (const r of this.runs.splice(0)) r.kill();
  }

  private set(p: Partial<CloneState> | ((s: CloneState) => Partial<CloneState>)) {
    this.cur = { ...this.cur, ...(typeof p === "function" ? p(this.cur) : p) };
    this.commit(this.cur);
  }

  private patchMsg(id: string, fn: (m: AssistantMsg) => Partial<AssistantMsg>) {
    this.set((s) => ({ messages: s.messages.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...fn(m) } : m)) }));
  }

  /** Finishes any reply still streaming, so leaving a chat never loses half of it. */
  private settle() {
    for (const r of this.runs.splice(0)) r.progress(1);
  }

  private stash() {
    this.settle();
    const s = this.cur;
    if (s.view === "chat" && s.activeChat) this.chats.set(s.activeChat, { title: s.chatTitle, messages: s.messages, panel: s.panel });
  }

  private cannedChat(id: string, title: string): Saved {
    const c = this.canned[id];
    if (!c) return { title, messages: [], panel: null };
    const answer: AssistantMsg = {
      id: `${id}-a`,
      role: "assistant",
      steps: c.steps.map(([label, icon], i) => ({ id: `${id}-s${i}`, label, icon, done: true })),
      stepsOpen: false,
      working: false,
      text: c.reply,
      streaming: false,
      footer: c.footer,
    };
    return { title, panel: null, messages: [{ id: `${id}-u`, role: "user", text: c.prompt, time: c.time }, answer] };
  }

  nav(view: View) {
    this.stash();
    if (view === "welcome") this.set({ view, messages: [], composer: "", panel: null, activeChat: null, chatTitle: "", modelMenu: false });
    else this.set({ view, modelMenu: false });
  }

  openChat(id: string) {
    if (this.cur.view === "chat" && this.cur.activeChat === id) return;
    this.stash();
    const title = this.cur.history.find((h) => h.id === id)?.title ?? "";
    const saved = this.chats.get(id) ?? this.cannedChat(id, title);
    this.set({ view: "chat", activeChat: id, chatTitle: saved.title, messages: saved.messages, panel: saved.panel, modelMenu: false });
  }

  toggleSteps(id: string) {
    this.patchMsg(id, (m) => ({ stepsOpen: !m.stepsOpen }));
  }

  openPanel(title: string, kind: ArtifactKind) {
    this.set({ panel: { title, kind, progress: 1 } });
  }

  closePanel() {
    this.set({ panel: null });
  }

  type(text: string) {
    this.set({ composer: text });
  }

  focus(on: boolean) {
    this.set({ composerFocus: on });
  }

  toggleModels() {
    this.set((s) => ({ modelMenu: !s.modelMenu }));
  }

  setModel(model: string) {
    this.set({ model, modelMenu: false });
  }

  toggleTask(id: string) {
    this.set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)) }));
  }

  toggleInbox(id: string) {
    this.set((s) => ({ inbox: s.inbox.map((i) => (i.id === id ? { ...i, open: !i.open, read: true } : i)) }));
  }

  dismissCta(id: string) {
    this.patchMsg(id, () => ({ cta: false }));
  }

  send() {
    const text = this.cur.composer.trim();
    if (!text || this.cur.working) return;
    this.settle();
    const k = ++this.n;
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const user: Msg = { id: `lu${k}`, role: "user", text, time };
    this.set((s) => {
      const fresh = s.view !== "chat" || !s.activeChat;
      const id = fresh ? `live${k}` : s.activeChat!;
      const title = fresh ? (text.length > 44 ? `${text.slice(0, 42)}…` : text) : s.chatTitle;
      return {
        view: "chat",
        activeChat: id,
        chatTitle: title,
        messages: fresh ? [user] : [...s.messages, user],
        composer: "",
        working: true,
        workingWord: THINKING_WORDS[k % THINKING_WORDS.length],
        panel: fresh ? null : s.panel,
        modelMenu: false,
        history: fresh ? [{ id, title, bucket: "Today" }, ...s.history] : s.history,
      };
    });

    const reply = REPLIES[Math.min(this.sent++, REPLIES.length - 1)];
    const aid = `la${k}`;
    const proxy = { n: 0 };
    let shown = -1;
    const run = gsap
      .timeline({ onComplete: () => (this.runs = this.runs.filter((r) => r !== run)) })
      .call(
        () => {
          const msg: AssistantMsg = { id: aid, role: "assistant", steps: [], stepsOpen: false, working: false, text: "", streaming: true };
          this.set((s) => ({ messages: [...s.messages, msg] }));
        },
        [],
        0.9,
      )
      .to(proxy, {
        n: reply.length,
        duration: reply.length / 170,
        ease: "none",
        onUpdate: () => {
          // Whole words at a time, like tokens arriving.
          let n = Math.round(proxy.n);
          if (n < reply.length) {
            const sp = reply.indexOf(" ", n);
            n = sp === -1 ? reply.length : sp;
          }
          if (n !== shown) {
            shown = n;
            this.patchMsg(aid, () => ({ text: reply.slice(0, n) }));
          }
        },
      })
      .call(() => {
        // Only the latest reply offers the buttons.
        this.set((s) => ({
          working: false,
          messages: s.messages.map((m) =>
            m.role !== "assistant" ? m : m.id === aid ? { ...m, text: reply, streaming: false, cta: true } : m.cta ? { ...m, cta: false } : m,
          ),
        }));
      });
    this.runs.push(run);
  }
}

/** Every action goes through `get`, which takes the window over first if it hasn't been yet. */
export function liveApi(get: () => LiveSession): LiveApi {
  return {
    nav: (v) => get().nav(v),
    openChat: (id) => get().openChat(id),
    toggleSteps: (id) => get().toggleSteps(id),
    openPanel: (t, k) => get().openPanel(t, k),
    closePanel: () => get().closePanel(),
    type: (t) => get().type(t),
    focus: (on) => get().focus(on),
    send: () => get().send(),
    toggleModels: () => get().toggleModels(),
    setModel: (m) => get().setModel(m),
    toggleTask: (id) => get().toggleTask(id),
    toggleInbox: (id) => get().toggleInbox(id),
    dismissCta: (id) => get().dismissCta(id),
  };
}

/** `active` once the visitor has taken the window over from the script. */
export const LiveContext = createContext<{ api: LiveApi; active: boolean } | null>(null);

export const useLive = () => useContext(LiveContext);

/** Makes a clone control clickable, when the clone is interactive at all. */
export function useHit() {
  const live = useLive();
  return (fn: (api: LiveApi) => void) => (live ? { "data-live": "", onClick: () => fn(live.api) } : {});
}
