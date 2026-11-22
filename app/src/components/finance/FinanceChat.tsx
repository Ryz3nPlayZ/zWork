/** The Finance section's own zWork chat, beside the dashboard. Runs as the "finance" crew member. */
import { lazy, Suspense, useEffect, useState } from "react";
import { SquarePen } from "lucide-react";
import { useApp } from "../../lib/store";
import { ChatInput } from "../ChatInput";
import { Spinner } from "./ui";
import type { FinanceView } from "./financeStore";

const ChatView = lazy(() => import("../ChatView").then((m) => ({ default: m.ChatView })));

export const FINANCE = "finance";

const CHAT_WIDTH_KEY = "zwork.financeChatWidth";
const CHAT_MIN = 320;
const CHAT_MAX = 760;
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, CHAT_MIN), CHAT_MAX));

export function FinanceChat({ symbol, name, isCompany, view }: { symbol: string; name: string; isCompany: boolean; view: FinanceView }) {
  const hasChat = useApp((s) => !!s.activeChatId && s.chats[s.activeChatId]?.crewId === FINANCE);
  const startNew = () => useApp.setState({ activeChatId: null, newChatCrewId: FINANCE });
  const [width, setWidth] = useState(() => {
    try {
      return clampWidth(Number(localStorage.getItem(CHAT_WIDTH_KEY)) || 400);
    } catch {
      return 400;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(width));
    } catch {
      /* private mode: width just isn't remembered */
    }
  }, [width]);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => setWidth(clampWidth(startW + startX - ev.clientX));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const short = name.split(/[ ,]/)[0] || symbol;
  const onStock = view === "stock" && !!symbol;
  const heading = onStock && isCompany ? `What do you want to know about ${short}?` : view === "portfolio" ? "What do you want to know about your portfolio?" : "What do you want to know about the market?";
  const ideas =
    onStock && isCompany
      ? [`How did ${short} do in its latest quarter?`, `Chart ${symbol}'s revenue and profit over five years`, `Alert me if ${symbol} drops 5%`]
      : view === "portfolio"
        ? ["How is my portfolio doing this month?", "Which of my holdings is the riskiest?", "Write me a one-page brief on my holdings"]
        : view === "screener"
          ? ["Find profitable tech companies under 25 P/E", "Which utilities pay the highest dividend?", "Show the biggest health care companies"]
          : ["What moved the market today?", "Which big companies report earnings this week?", "Compare Apple, Microsoft and Google this year"];
  return (
    // No background of its own: the page (or the wallpaper tint) shows through so the panel reads as part of it.
    // shortcut: max-w-[55%] caps a remembered width on small windows without re-clamping state; dragging from there feels sticky until it's back in range.
    <aside style={{ width }} className="relative flex min-w-0 max-w-[55%] shrink-0 flex-col border-l border-line">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat"
        aria-valuenow={width}
        aria-valuemin={CHAT_MIN}
        aria-valuemax={CHAT_MAX}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => setWidth(400)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setWidth((w) => clampWidth(w + 24));
          if (e.key === "ArrowRight") setWidth((w) => clampWidth(w - 24));
        }}
        title="Drag to resize. Double-click to reset."
        className="group absolute inset-y-0 -left-[4px] z-30 w-[8px] cursor-col-resize focus:outline-none"
      >
        <div className="mx-auto h-full w-[2px] rounded-full transition-colors duration-150 group-hover:bg-ink/25 group-focus-visible:bg-ink/50 group-active:bg-ink/40" />
      </div>

      {hasChat ? (
        <>
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
              {onStock ? `Ask zWork about ${isCompany ? symbol : name}` : "Ask zWork"}
            </span>
            <button
              type="button"
              onClick={startNew}
              className="press ring-focus inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink"
            >
              <SquarePen className="h-3.5 w-3.5" /> New chat
            </button>
          </div>
          <div className="relative flex min-h-0 flex-1">
            <Suspense fallback={<Spinner />}>
              <ChatView embedded />
            </Suspense>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5">
          <div className="flex flex-1 flex-col justify-center">
            <h2 className="text-balance text-center font-serif text-[30px] font-light leading-tight tracking-tight text-ink">{heading}</h2>
            <div className="mt-6">
              <ChatInput placeholder="Ask about a stock, a filing or the market" compact />
            </div>
            <ul className="mt-3 flex flex-col">
              {ideas.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() => void useApp.getState().send(t)}
                    className="press ring-focus w-full rounded-lg px-3 py-2 text-left text-[13px] text-ink-muted transition-colors duration-150 hover:bg-state-hover hover:text-ink"
                  >
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <p className="pb-4 text-center text-[11.5px] text-ink-faint">Uses live prices, SEC filings and news. Research, not personal investment advice.</p>
        </div>
      )}
    </aside>
  );
}
