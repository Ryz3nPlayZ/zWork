import { Logo } from "./Logo";

function SidebarIcon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#6b6a65]">
      <path d={d} />
    </svg>
  );
}

function ChatItem({ title, active }: { title: string; active?: boolean }) {
  return (
    <div className={`px-2 py-1.5 rounded-md text-[11.5px] truncate ${active ? "bg-white shadow-[0_0_0_1px_rgba(17,17,17,0.06)] text-[#171716]" : "text-[#6b6a65] hover:bg-[#e6e3dc]/60"}`}>
      {title}
    </div>
  );
}

export function AppMockup() {
  return (
    <div className="relative w-full max-w-[920px] mx-auto">
      {/* Window chrome */}
      <div className="rounded-xl border border-[#e6e3dc] bg-[#f7f6f3] shadow-[0_1px_2px_rgba(17,17,17,0.04),0_12px_32px_rgba(17,17,17,0.08)] overflow-hidden">
        {/* Title bar / toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e6e3dc] bg-[#fbfaf7]">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#e6e3dc]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#e6e3dc]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#e6e3dc]" />
          </div>
          <span className="ml-2 text-[10.5px] text-[#a09e98] font-medium">zWork</span>
        </div>

        <div className="flex h-[420px] md:h-[480px]">
          {/* Sidebar */}
          <div className="w-[200px] shrink-0 flex flex-col border-r border-[#e6e3dc] bg-[#f2f0ec]">
            {/* Logo row */}
            <div className="flex items-center gap-2 px-3 py-2.5">
              <Logo size={20} fill="#171716" />
              <span className="text-[13px] font-semibold tracking-tight text-[#171716]">
                <span className="lowercase">z</span>Work
              </span>
            </div>

            {/* Actions */}
            <div className="px-2 flex flex-col gap-0.5 pt-1 pb-2">
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] text-[#6b6a65] hover:bg-[#e6e3dc]/60 cursor-default">
                <SidebarIcon d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                New chat
                <span className="ml-auto font-mono text-[10px] text-[#a09e98]">⌘N</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] text-[#6b6a65] hover:bg-[#e6e3dc]/60 cursor-default">
                <SidebarIcon d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                Search
                <span className="ml-auto font-mono text-[10px] text-[#a09e98]">⌘K</span>
              </div>
            </div>

            {/* Chat history */}
            <div className="flex-1 overflow-hidden px-2 pb-2">
              <div className="px-2 mt-2 mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#a09e98]">Today</span>
              </div>
              <ChatItem title="Refactor auth module" active />
              <ChatItem title="Docker compose setup" />

              <div className="px-2 mt-3 mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#a09e98]">This week</span>
              </div>
              <ChatItem title="Landing page redesign" />
              <ChatItem title="API rate limiting" />
              <ChatItem title="Stripe integration plan" />
            </div>

            {/* Settings */}
            <div className="border-t border-[#e6e3dc] p-2">
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] text-[#6b6a65] hover:bg-[#e6e3dc]/60 cursor-default">
                <SidebarIcon d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                Settings
                <span className="ml-auto font-mono text-[10px] text-[#a09e98]">⌘,</span>
              </div>
            </div>
          </div>

          {/* Main area */}
          <div className="flex-1 flex flex-col min-w-0 bg-[#f7f6f3] relative">
            {/* Greeting */}
            <div className="flex-1 flex flex-col items-center justify-center px-6">
              <h2 className="text-center text-[28px] md:text-[34px] font-light leading-tight tracking-tight text-[#171716]" style={{ fontFamily: "var(--font-serif)" }}>
                Good afternoon, <span className="italic text-[#6b6a65]">there</span>.
              </h2>

              {/* Chat input */}
              <div className="mt-6 w-full max-w-[520px]">
                <div className="rounded-xl border border-[#e6e3dc] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04),0_8px_24px_rgba(17,17,17,0.06)]">
                  <div className="px-4 pt-3 pb-2">
                    <div className="text-[13.5px] text-[#a09e98] leading-6">
                      What can I help with?
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 px-2 pb-2">
                    <div className="flex items-center gap-1">
                      <div className="h-7 w-7 rounded-md flex items-center justify-center text-[#6b6a65]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                      </div>
                      <div className="h-7 w-7 rounded-md flex items-center justify-center text-[#6b6a65]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>
                      </div>
                      <div className="h-7 w-7 rounded-md flex items-center justify-center text-[#6b6a65]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10.5px] text-[#a09e98]">GPT-4o</span>
                      <div className="h-6 w-6 rounded-full bg-[#efede8] flex items-center justify-center text-[#171716]">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Composer hint */}
            <div className="shrink-0 px-6 pb-4">
              <p className="text-center text-[10px] text-[#a09e98]">
                zWork can take actions on your computer. Review before approving.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Subtle glow behind */}
      <div
        className="absolute -inset-4 -z-10 rounded-3xl opacity-40 blur-2xl"
        style={{
          background: "linear-gradient(135deg, rgba(247,246,243,0.8) 0%, rgba(230,227,220,0.6) 100%)",
        }}
      />
    </div>
  );
}
