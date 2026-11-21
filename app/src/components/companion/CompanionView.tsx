import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BotAvatar, botAvatarTypes, type BotAvatarType } from "bot-avatars";
import { AlertCircle, AppWindow, Bell, CheckCircle2, EyeOff, MessageCircle, Mic, SquarePen, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { useApp } from "../../lib/store";
import { IS_TAURI } from "../../lib/platform";
import { useResolvedTheme } from "../../lib/theme";
import { dictationSupported } from "../../lib/dictation";
import { onDragMouseDown } from "../../lib/drag";
import { COMPANION_CREW_KEY, COMPANION_KEY, watchChats, type TaskDone } from "../../lib/companionBus";
import {
  PET_H, PET_W, applyWindow, clampPet, layout, loadPetPos, savePetPos, workArea,
  type Layout, type Pt,
} from "../../lib/companionWindow";
import { Message } from "../Message";
import { ChatInput } from "../ChatInput";
import { IconButton } from "../IconButton";

type View = "pet" | "chat" | "note";
const CHAT_W = 380;
const NOTE = { w: 288, h: 92 };

/** Where the textarea's caret is, in viewport coordinates (mirror-div measurement). */
function caretPoint(ta: HTMLTextAreaElement): Pt {
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const div = document.createElement("div");
  const st = div.style;
  st.font = cs.font;
  st.letterSpacing = cs.letterSpacing;
  st.padding = cs.padding;
  st.border = cs.border;
  st.boxSizing = cs.boxSizing;
  st.width = cs.width;
  st.whiteSpace = "pre-wrap";
  st.overflowWrap = "break-word";
  st.position = "fixed";
  st.visibility = "hidden";
  st.left = `${r.left}px`;
  st.top = `${r.top}px`;
  div.textContent = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
  const mark = document.createElement("span");
  mark.textContent = "​";
  div.appendChild(mark);
  document.body.appendChild(div);
  const m = mark.getBoundingClientRect();
  div.remove();
  return { x: m.left, y: m.top + m.height / 2 - ta.scrollTop };
}

const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));

export function CompanionView() {
  const theme = useResolvedTheme();
  const bootstrap = useApp((s) => s.bootstrap);
  const fetchCrew = useApp((s) => s.fetchCrew);
  const crew = useApp((s) => s.crew);
  const activeChatId = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (s.activeChatId ? s.chats[s.activeChatId] : undefined));
  const regenerateMessage = useApp((s) => s.regenerateMessage);
  const flagBadResponse = useApp((s) => s.flagBadResponse);

  const [crewKey, setCrewKey] = useState(() => localStorage.getItem(COMPANION_CREW_KEY) || "");
  const member = crew.find((m) => m.id === crewKey) ?? crew[0];
  const name = member?.name || "zWork";
  const avatarType: BotAvatarType = member && botAvatarTypes.includes(member.avatar as BotAvatarType)
    ? (member.avatar as BotAvatarType)
    : "clover";

  const [view, setView] = useState<View>("pet");
  const [geo, setGeo] = useState<Layout>(() => layout({ x: 0, y: 0 }, null, { x: 0, y: 0, w: 9999, h: 9999 }));
  const petPos = useRef<Pt | null>(loadPetPos());
  const selfMoveUntil = useRef(0);
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<number>();
  const [mainWorking, setMainWorking] = useState(false);
  const [ownWorking, setOwnWorking] = useState(false);
  const [notice, setNotice] = useState<TaskDone | null>(null);
  const [unread, setUnread] = useState(false);
  const [dictateNonce, setDictateNonce] = useState(0);
  const [pose, setPose] = useState<{ yaw: number; pitch: number } | undefined>();
  const gazeTimer = useRef<number>();
  const viewRef = useRef(view);
  viewRef.current = view;
  const scrollRef = useRef<HTMLDivElement>(null);

  const hasMessages = !!chat && chat.messages.length > 0;
  const working = mainWorking || ownWorking;

  // ── Boot: providers, crew, visibility ───────────────────────────────────
  useEffect(() => {
    void bootstrap();
    void fetchCrew();
    if (!IS_TAURI || localStorage.getItem(COMPANION_KEY) === "off") return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().show());
  }, [bootstrap, fetchCrew]);

  // New chats from the companion go to the crew member it shows.
  useEffect(() => {
    if (member && !activeChatId) void useApp.getState().setChatCrew(member.id);
  }, [member, activeChatId]);

  // ── Window placement ────────────────────────────────────────────────────
  const cardSize = view === "chat" ? { w: CHAT_W, h: hasMessages ? 520 : 300 } : view === "note" ? NOTE : null;
  const place = useCallback(async (size: { w: number; h: number } | null) => {
    const area = await workArea();
    const pet = clampPet(petPos.current, area);
    petPos.current = pet;
    const next = layout(pet, size, area);
    if (IS_TAURI) {
      selfMoveUntil.current = Date.now() + 500;
      // shortcut: window and content move in two steps, so the pet can flicker for a frame when a card opens; a native panel would fix it.
      await applyWindow(next.win).catch(() => {});
    }
    setGeo(next);
  }, []);
  const sizeKey = cardSize ? `${cardSize.w}x${cardSize.h}` : "none";
  useEffect(() => {
    void place(cardSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizeKey stands for cardSize
  }, [sizeKey, place]);

  // Dragging moves the whole window; remember where the pet ended up and
  // re-place the card once the drag settles (it may need to flip or slide).
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const sizeRef = useRef(cardSize);
  sizeRef.current = cardSize;
  useEffect(() => {
    if (!IS_TAURI) return;
    let un: (() => void) | undefined;
    let settle: number | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const u = await win.onMoved(async ({ payload }) => {
        if (Date.now() < selfMoveUntil.current) return;
        const s = await win.scaleFactor();
        const g = geoRef.current;
        petPos.current = { x: payload.x / s + g.pet.x, y: payload.y / s + g.pet.y };
        savePetPos(petPos.current);
        window.clearTimeout(settle);
        settle = window.setTimeout(() => void place(sizeRef.current), 300);
      });
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      window.clearTimeout(settle);
      un?.();
    };
  }, [place]);

  // ── Chat activity and finished-task notes ───────────────────────────────
  const showNotice = useCallback((d: TaskDone) => {
    // You're already looking at that chat in the card.
    if (viewRef.current === "chat" && useApp.getState().activeChatId === d.id) return;
    setNotice(d);
    setUnread(true);
    if (viewRef.current !== "chat") setView("note");
  }, []);
  useEffect(() => watchChats(setOwnWorking, showNotice), [showNotice]);
  // A Dictate press only counts for the card it opened.
  useEffect(() => {
    if (view !== "chat") setDictateNonce(0);
  }, [view]);
  useEffect(() => {
    if (view !== "note") return;
    const t = window.setTimeout(() => setView((v) => (v === "note" ? "pet" : v)), 8000);
    return () => window.clearTimeout(t);
  }, [view, notice]);

  // Events from the main window and the Rust shortcut handler.
  const openChat = useCallback(async (focus = true) => {
    setView("chat");
    setUnread(false);
    if (focus && IS_TAURI) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFocus().catch(() => {});
    }
  }, []);
  useEffect(() => {
    if (!IS_TAURI) return;
    const offs: Array<() => void> = [];
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      const add = (p: Promise<() => void>) => void p.then((u) => (cancelled ? u() : offs.push(u)));
      add(listen<boolean>("companion:working", (e) => setMainWorking(!!e.payload)));
      add(listen<TaskDone>("companion:task-done", (e) => e.payload && showNotice(e.payload)));
      add(listen("companion-summon", () => {
        if (viewRef.current === "chat") setView("pet");
        else void openChat();
      }));
      add(listen<{ crewId?: string }>("companion:config", (e) => {
        setCrewKey(e.payload?.crewId ?? localStorage.getItem(COMPANION_CREW_KEY) ?? "");
        void fetchCrew();
      }));
      // Captures from the Share Window picker become attachments in the card's composer.
      add(listen<{ dataUrl: string; mime: string }>("share-window-captured", (e) => {
        if (!e.payload?.dataUrl) return;
        useApp.getState().pushPendingShareImage({ dataUrl: e.payload.dataUrl, mime: e.payload.mime || "image/png", name: "Shared window" });
        void openChat();
      }));
    });
    return () => {
      cancelled = true;
      offs.forEach((u) => u());
    };
  }, [showNotice, openChat, fetchCrew]);

  // Escape folds the card back down to the pet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && viewRef.current !== "pet") {
        e.preventDefault();
        setView("pet");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chat?.messages.length, chat?.working, chat?.status, view]);

  // ── Gaze: while you type in the card, the pet looks at your caret ──────
  useEffect(() => {
    const look = () => {
      const ta = document.activeElement;
      if (!(ta instanceof HTMLTextAreaElement)) return;
      const c = caretPoint(ta);
      const g = geoRef.current;
      const dx = c.x - (g.pet.x + PET_W / 2);
      const dy = c.y - (g.pet.y + 46);
      setPose({ yaw: clamp(dx / 260, 0.7), pitch: clamp(-dy / 260, 0.5) });
      window.clearTimeout(gazeTimer.current);
      gazeTimer.current = window.setTimeout(() => setPose(undefined), 1600);
    };
    document.addEventListener("input", look, true);
    document.addEventListener("keyup", look, true);
    return () => {
      document.removeEventListener("input", look, true);
      document.removeEventListener("keyup", look, true);
      window.clearTimeout(gazeTimer.current);
    };
  }, []);

  // ── Card actions ────────────────────────────────────────────────────────
  const newChat = () => {
    useApp.getState().openLanding();
    if (member) void useApp.getState().setChatCrew(member.id);
  };
  const openInApp = async () => {
    if (!IS_TAURI) return;
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", "companion:open-chat", { id: activeChatId ?? "" }).catch(() => {});
    setView("pet");
  };
  const putAway = async () => {
    localStorage.setItem(COMPANION_KEY, "off");
    setView("pet");
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  };
  const openNotice = async () => {
    if (!notice) return;
    await useApp.getState().refreshChats();
    await useApp.getState().openChat(notice.id);
    setNotice(null);
    void openChat();
  };

  // The question / permission card the composer turns into (same as ChatView).
  const gate = useMemo(() => {
    if (!chat) return null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (msg.role !== "assistant") continue;
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (part.kind === "tool" && part.pendingGate) {
          return { messageId: msg.id, gateId: part.pendingGate.gateId, reason: part.pendingGate.reason };
        }
      }
    }
    return null;
  }, [chat]);
  const mode = chat?.pendingQuestion ? "question" : gate ? "permission" : "default";

  const at = (r: { x: number; y: number; w?: number; h?: number }): CSSProperties => ({
    left: r.x, top: r.y, width: r.w, height: r.h,
  });
  const expanded = hover;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent">
      {geo.card && view === "chat" && (
        <div
          style={at(geo.card)}
          className="absolute flex animate-fade-in flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-float"
        >
          <div
            onMouseDown={onDragMouseDown}
            className="flex h-11 shrink-0 cursor-grab items-center gap-1 pl-4 pr-1.5 active:cursor-grabbing"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {chat?.title && hasMessages ? chat.title : name}
            </span>
            <div data-no-drag className="flex items-center">
              <IconButton icon={<SquarePen className="h-4 w-4" />} label="New chat" variant="ghost" size="sm" onClick={newChat} />
              <IconButton icon={<AppWindow className="h-4 w-4" />} label="Open in zWork" variant="ghost" size="sm" onClick={() => void openInApp()} />
              <IconButton icon={<EyeOff className="h-4 w-4" />} label="Hide companion (turn it back on in Settings)" variant="ghost" size="sm" onClick={() => void putAway()} />
              <IconButton icon={<X className="h-4 w-4" />} label="Close (Esc)" variant="ghost" size="sm" onClick={() => setView("pet")} />
            </div>
          </div>
          <div ref={scrollRef} data-no-drag className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4">
            {hasMessages && chat ? (
              <div className="flex flex-col gap-4 pb-4 pt-1">
                {chat.messages.map((m, idx) => {
                  const streaming = !!chat.working && idx === chat.messages.length - 1;
                  return (
                    <Message
                      key={m.id}
                      message={m}
                      streaming={streaming}
                      activities={streaming && m.role === "assistant" ? chat.activities : m.activities}
                      status={streaming ? chat.status : undefined}
                      onRetry={regenerateMessage}
                      onBadResponse={flagBadResponse}
                    />
                  );
                })}
                {chat.error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-snug text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                    {chat.error}
                  </div>
                )}
              </div>
            ) : (
              <p className="pt-1 text-[13px] leading-relaxed text-ink-muted">
                Ask {name} for something while you work. It keeps going if you close this.
              </p>
            )}
          </div>
          <div className="shrink-0 p-2">
            <ChatInput
              variant="overlay"
              autoFocus
              placeholder={`Ask ${name}…`}
              onDismiss={() => setView("pet")}
              dictateNonce={dictateNonce}
              mode={mode}
              question={chat?.pendingQuestion ? { question: chat.pendingQuestion.question, options: chat.pendingQuestion.options } : undefined}
              permission={gate ? { reason: gate.reason } : undefined}
              onAnswerQuestion={(a) => chat && void useApp.getState().answerQuestion(chat.id, a)}
              onResolvePermission={(allow, otherText) => {
                if (!chat || !gate) return;
                void useApp.getState().resolveGate(chat.id, gate.messageId, gate.gateId, allow);
                // Deny-with-instruction: the typed text goes to the agent as the next message.
                if (!allow && otherText?.trim()) void useApp.getState().send(otherText.trim());
              }}
            />
          </div>
        </div>
      )}

      {geo.card && view === "note" && notice && (
        <div
          style={at(geo.card)}
          className="absolute flex animate-fade-in items-start gap-2.5 rounded-2xl border border-line bg-paper p-3 pr-1.5 shadow-float"
        >
          {notice.failed
            ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
          <button type="button" onClick={() => void openNotice()} className="ring-focus min-w-0 flex-1 rounded-md text-left">
            <span className="block truncate text-[13px] font-medium text-ink">
              {notice.failed ? `${notice.title} stopped` : `${notice.title} is done`}
            </span>
            <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-muted">
              {notice.snippet || "Open it to see the result."}
            </span>
          </button>
          <IconButton icon={<X className="h-3.5 w-3.5" />} label="Dismiss" variant="ghost" size="sm" onClick={() => setView("pet")} />
        </div>
      )}

      {/* The pet: drag it anywhere; hover for the bar's buttons. */}
      <div
        style={at({ ...geo.pet, w: PET_W, h: PET_H })}
        className="absolute flex flex-col items-center justify-end pb-2"
        onMouseEnter={() => {
          window.clearTimeout(hoverTimer.current);
          setHover(true);
        }}
        onMouseLeave={() => {
          hoverTimer.current = window.setTimeout(() => setHover(false), 250);
        }}
      >
        <div
          onMouseDown={onDragMouseDown}
          onClick={() => (view === "chat" ? setView("pet") : void openChat())}
          className="cursor-grab active:cursor-grabbing"
          title={`${name}: drag to move, click to chat`}
        >
          <BotAvatar
            type={avatarType}
            color={member?.color || "#d97757"}
            size={80}
            state={working ? "working" : "default"}
            pose={pose}
            shading="smooth"
            theme={theme}
            role="img"
            aria-label={working ? `${name}, working` : name}
          />
        </div>
        <div className="mt-1 flex h-8 items-center justify-center">
          <div
            data-no-drag
            className={cn(
              "flex items-center justify-center overflow-hidden rounded-full transition-all duration-200 ease-out",
              expanded
                ? "h-8 gap-0.5 border border-line bg-paper px-1 shadow-pop"
                : cn("h-[5px] w-9", unread ? "bg-emerald-500" : "bg-black/55 ring-1 ring-white/60"),
              expanded && unread && "border-emerald-500/60",
            )}
          >
            {expanded && (
              <>
                <IconButton icon={<MessageCircle className="h-4 w-4" />} label="Chat" className="rounded-full" variant="ghost" size="sm" tooltipSide="top" onClick={() => void openChat()} />
                {dictationSupported && (
                  <IconButton
                    icon={<Mic className="h-4 w-4" />}
                    label="Dictate" className="rounded-full"
                    variant="ghost"
                    size="sm"
                    tooltipSide="top"
                    onClick={() => {
                      void openChat();
                      setDictateNonce((n) => n + 1);
                    }}
                  />
                )}
                {unread && notice && (
                  <IconButton
                    icon={<Bell className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
                    label="See what finished" className="rounded-full"
                    variant="ghost"
                    size="sm"
                    tooltipSide="top"
                    onClick={() => void openNotice()}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
