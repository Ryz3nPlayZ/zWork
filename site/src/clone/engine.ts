import gsap from "gsap";
import type { CannedChat } from "./live";
import type { AssistantMsg, CloneState, Msg, Step, ToolIcon } from "./types";

export const THINKING_WORDS = [
  "Crunching", "Cogitating", "Percolating", "Untangling", "Reticulating",
  "Simmering", "Combobulating", "Noodling", "Brewing", "Wrangling",
];

type Patch = Partial<CloneState> | ((s: CloneState) => Partial<CloneState>);

/**
 * Builds one scripted run of the clone on a GSAP timeline. Every state change
 * is a timeline callback and every gradual change (typing, streaming, the
 * document filling in) is a tween on a proxy, so the whole demo pauses,
 * resumes and loops as one timeline.
 */
export class Script {
  readonly tl = gsap.timeline({ paused: true });
  private cur: CloneState;
  private id = 0;

  constructor(
    private initial: CloneState,
    private commit: (s: CloneState) => void,
    private root: HTMLElement,
    private onChapter?: (name: string) => void,
  ) {
    this.cur = initial;
    this.tl.call(() => {
      this.cur = this.initial;
      this.commit(this.cur);
      const c = this.cursorEl();
      if (c) gsap.set(c, { autoAlpha: 0, x: this.initialCursor.x, y: this.initialCursor.y });
    });
  }

  private initialCursor = { x: -60, y: -60 };

  /** Where the run has got to. */
  get state() {
    return this.cur;
  }

  private apply(p: Patch) {
    const next = typeof p === "function" ? p(this.cur) : p;
    this.cur = { ...this.cur, ...next };
    this.commit(this.cur);
  }

  private cursorEl() {
    return this.root.querySelector<HTMLElement>("[data-cursor]");
  }

  /** Centre-ish of a [data-target] element, in the window's own pixels.
   *  Walks offsets instead of measuring rects so page-level transforms
   *  (the hero tilt, the fit-to-width scale) don't skew the result. */
  private point(target: string) {
    const el = this.root.querySelector<HTMLElement>(`[data-target="${target}"]`);
    if (!el) return { x: this.root.offsetWidth / 2, y: this.root.offsetHeight / 2 };
    let x = 0;
    let y = 0;
    let node: HTMLElement | null = el;
    while (node && node !== this.root) {
      x += node.offsetLeft;
      y += node.offsetTop;
      const parent = node.offsetParent as HTMLElement | null;
      for (let p: HTMLElement | null = node.parentElement; p && p !== parent; p = p.parentElement) {
        x -= p.scrollLeft;
        y -= p.scrollTop;
      }
      if (parent && parent !== this.root) {
        x -= parent.scrollLeft;
        y -= parent.scrollTop;
      }
      node = parent;
    }
    return { x: x + Math.min(el.offsetWidth * 0.5, 60), y: y + el.offsetHeight * 0.55 };
  }

  nextId(prefix = "m") {
    return `${prefix}${++this.id}`;
  }

  chapter(name: string) {
    this.tl.call(() => this.onChapter?.(name));
    return this;
  }

  do(p: Patch) {
    this.tl.call(() => this.apply(p));
    return this;
  }

  wait(seconds: number) {
    this.tl.to({}, { duration: seconds });
    return this;
  }

  /** Types into the composer at a human-ish pace. */
  type(text: string, cps = 34) {
    const proxy = { n: 0 };
    let shown = -1;
    this.do({ composerFocus: true });
    this.tl.fromTo(
      proxy,
      { n: 0 },
      {
        n: text.length,
        duration: text.length / cps,
        ease: "power1.inOut",
        onUpdate: () => {
          const n = Math.round(proxy.n);
          if (n !== shown) {
            shown = n;
            this.apply({ composer: text.slice(0, n) });
          }
        },
      },
    );
    return this;
  }

  /** Sends what's in the composer as a user message and starts working. */
  send(opts: { time: string; attachment?: string; title?: string; historyId?: string }) {
    this.click("send", false);
    this.do((s) => {
      const msg: Msg = { id: this.nextId("u"), role: "user", text: s.composer, time: opts.time, attachment: opts.attachment };
      const hid = opts.historyId ?? "chat-new";
      const title = opts.title ?? s.composer;
      return {
        view: "chat",
        composer: "",
        composerFocus: false,
        working: true,
        workingWord: THINKING_WORDS[0],
        messages: [...s.messages, msg],
        chatTitle: title,
        activeChat: hid,
        history: s.history.some((h) => h.id === hid) ? s.history : [{ id: hid, title, bucket: "Today" }, ...s.history],
      };
    });
    return this;
  }

  private patchMsg(id: string, fn: (m: AssistantMsg) => Partial<AssistantMsg>) {
    this.apply((s) => ({
      messages: s.messages.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...fn(m) } : m)),
    }));
  }

  assistant(id: string) {
    this.do((s) => ({
      messages: [
        ...s.messages,
        { id, role: "assistant", steps: [], stepsOpen: true, working: true, text: "", streaming: false } satisfies AssistantMsg,
      ],
    }));
    return this;
  }

  /** One tool call: appears running, then ticks done. */
  step(msgId: string, label: string, icon: ToolIcon, seconds = 0.9) {
    const sid = this.nextId("s");
    this.tl.call(() => this.patchMsg(msgId, (m) => ({ steps: [...m.steps, { id: sid, label, icon, done: false } satisfies Step] })));
    this.wait(seconds);
    this.tl.call(() => this.patchMsg(msgId, (m) => ({ steps: m.steps.map((st) => (st.id === sid ? { ...st, done: true } : st)) })));
    return this;
  }

  word(i: number) {
    return this.do({ workingWord: THINKING_WORDS[i % THINKING_WORDS.length] });
  }

  msg(msgId: string, patch: Partial<AssistantMsg>) {
    this.tl.call(() => this.patchMsg(msgId, () => patch));
    return this;
  }

  /** Streams the assistant's reply token by token. */
  stream(msgId: string, text: string, cps = 140) {
    const proxy = { n: 0 };
    let shown = -1;
    this.msg(msgId, { streaming: true });
    this.tl.fromTo(
      proxy,
      { n: 0 },
      {
        n: text.length,
        duration: text.length / cps,
        ease: "none",
        onUpdate: () => {
          // Whole words at a time, like tokens arriving.
          let n = Math.round(proxy.n);
          if (n < text.length) {
            const sp = text.indexOf(" ", n);
            n = sp === -1 ? text.length : sp;
          }
          if (n !== shown) {
            shown = n;
            this.patchMsg(msgId, () => ({ text: text.slice(0, n) }));
          }
        },
      },
    );
    this.msg(msgId, { streaming: false, text });
    return this;
  }

  /** Fills the open document panel from 0 to 1. */
  write(seconds: number) {
    const proxy = { p: 0 };
    this.tl.fromTo(
      proxy,
      { p: 0 },
      {
        p: 1,
        duration: seconds,
        ease: "none",
        onUpdate: () => this.apply((s) => (s.panel ? { panel: { ...s.panel, progress: proxy.p } } : {})),
      },
    );
    return this;
  }

  showCursor(from?: { x: number; y: number }) {
    if (from) this.initialCursor = from;
    const c = this.cursorEl();
    if (c) this.tl.to(c, { autoAlpha: 1, duration: 0.25 });
    return this;
  }

  hideCursor() {
    const c = this.cursorEl();
    if (c) this.tl.to(c, { autoAlpha: 0, duration: 0.3 });
    return this;
  }

  /** Glides the pointer onto a [data-target]. Positions are read when the move starts. */
  moveTo(target: string, seconds = 0.8) {
    const c = this.cursorEl();
    if (!c) return this;
    this.tl.to(c, {
      x: () => this.point(target).x,
      y: () => this.point(target).y,
      duration: seconds,
      ease: "power3.inOut",
    });
    return this;
  }

  /** Press feedback on a control (and a ripple if the pointer is showing). */
  click(target: string, ripple = true) {
    this.do({ pressed: target });
    const ring = this.root.querySelector("[data-cursor-ring]");
    if (ripple && ring) {
      this.tl.fromTo(
        ring,
        { scale: 0.4, autoAlpha: 0.9 },
        { scale: 1.6, autoAlpha: 0, duration: 0.45, ease: "power2.out" },
        "<",
      );
    }
    this.wait(0.16);
    this.do({ pressed: null });
    return this;
  }

}

export type Scenario = {
  initial: CloneState;
  build: (s: Script) => void;
  /** What's behind the sidebar's past chats, for the hands-on demo. */
  chats?: Record<string, CannedChat>;
};

export function baseState(over: Partial<CloneState> = {}): CloneState {
  return {
    view: "welcome",
    history: [],
    activeChat: null,
    chatTitle: "",
    messages: [],
    composer: "",
    composerFocus: false,
    working: false,
    workingWord: THINKING_WORDS[0],
    permission: null,
    panel: null,
    tasks: [],
    inbox: [],
    model: "zWork Pro",
    preset: "ask",
    modelMenu: false,
    pressed: null,
    ...over,
  };
}
