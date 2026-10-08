import { TopBar } from "../components/TopBar";
import { Footer } from "../components/Footer";
import { HeroDemo } from "../components/demos/HeroDemo";
import { FileReadingDemo } from "../components/demos/FileReadingDemo";
import { TaskDemo } from "../components/demos/TaskDemo";
import { OutputDemo } from "../components/demos/OutputDemo";

const serif = { fontFamily: "var(--font-serif)" };

export default function HomePage() {
  return (
    <div className="relative min-h-screen bg-[#f7f6f3]">
      <TopBar visible={true} />

      {/* ---------- HERO ---------- */}
      <section className="pt-28 md:pt-32 pb-4 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h1
            className="text-[44px] md:text-[60px] lg:text-[76px] font-semibold tracking-tight text-[#171716] leading-[1.08]"
            style={serif}
          >
            Chat that<br />produces<br />the work.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-[#6b6a65] max-w-xl mx-auto leading-relaxed">
            The AI agent for people who don't want a terminal. Automates your computer, your files, your day — privately, on your machine.
          </p>
          <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="/download"
              className="inline-flex items-center gap-2 rounded-full bg-[#171716] px-6 py-3 text-[14px] font-semibold text-[#f7f6f3] hover:bg-[#25241f] transition-colors"
            >
              Download for free →
            </a>
            <a
              href="#"
              className="inline-flex items-center gap-2 rounded-full border border-[#e6e3dc] px-6 py-3 text-[14px] font-medium text-[#6b6a65] hover:text-[#171716] hover:border-[#d5d1c7] transition-colors"
            >
              Join Cloud waitlist
            </a>
          </div>
          <p className="mt-3 text-[12px] text-[#a09e98] tracking-wide">
            macOS · Windows · Linux  ·  Bring your own key or use zWork Cloud
          </p>
        </div>
      </section>

      {/* Hero demo visual */}
      <section className="px-4 md:px-6 pb-6 max-w-5xl mx-auto">
        <HeroDemo />
      </section>

      {/* ---------- WHAT IT DOES ---------- */}
      <section className="py-20 md:py-28 px-6 border-t border-[#e6e3dc] bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="mb-16 md:mb-24 max-w-2xl">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] block mb-4">
              What it does
            </span>
            <h2
              className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-[#171716] mb-4"
              style={serif}
            >
              Your computer,<br />working for you.
            </h2>
            <p className="text-lg md:text-xl text-[#6b6a65] leading-relaxed max-w-xl">
              Not another chat window. zWork reads, writes, and acts — across your files, apps, and the web.
            </p>
          </div>

          {/* Feature 1: Reads your files + demo */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center mb-20 md:mb-28">
            <div className="order-2 lg:order-1">
              <div className="max-w-md">
                <h3 className="text-2xl md:text-3xl font-semibold tracking-tight text-[#171716] mb-3" style={serif}>
                  Reads your files
                </h3>
                <p className="text-[15px] md:text-base text-[#6b6a65] leading-relaxed">
                  Drop in PDFs, notes, spreadsheets. zWork reads them, summarises them, and acts on what's inside.
                </p>
              </div>
            </div>
            <div className="order-1 lg:order-2">
              <FileReadingDemo />
            </div>
          </div>

          {/* Feature 2: Creates real output + demo */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center mb-20 md:mb-28">
            <div className="order-1">
              <OutputDemo />
            </div>
            <div className="order-2">
              <div className="max-w-md lg:ml-auto">
                <h3 className="text-2xl md:text-3xl font-semibold tracking-tight text-[#171716] mb-3" style={serif}>
                  Creates real output
                </h3>
                <p className="text-[15px] md:text-base text-[#6b6a65] leading-relaxed">
                  Reports, action lists, emails, calendar events. Not chat — finished work you can actually use.
                </p>
              </div>
            </div>
          </div>

          {/* Feature 3: Runs tasks for you + demo */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center mb-20 md:mb-28">
            <div className="order-2 lg:order-1">
              <div className="max-w-md">
                <h3 className="text-2xl md:text-3xl font-semibold tracking-tight text-[#171716] mb-3" style={serif}>
                  Runs tasks for you
                </h3>
                <p className="text-[15px] md:text-base text-[#6b6a65] leading-relaxed">
                  Tell it what to do and walk away. zWork handles multi-step tasks end to end, on your machine.
                </p>
              </div>
            </div>
            <div className="order-1 lg:order-2">
              <TaskDemo />
            </div>
          </div>

          {/* Remaining 3 features as cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-12 border-t border-[#e6e3dc]">
            <FeatureCard
              title="Private by default"
              body="Everything runs on your machine. Your files never leave. BYOK means your data stays yours."
            />
            <FeatureCard
              title="No terminal required"
              body="Built for everyone. If you can type a message, you can use zWork. No setup, no config, no CLI."
            />
            <FeatureCard
              title="Connects everything"
              body="Google Workspace, calendar, email, and more. One place to handle all of it — no switching apps."
            />
          </div>
        </div>
      </section>

      {/* ---------- HOW IT WORKS ---------- */}
      <section className="py-20 md:py-28 px-6 bg-[#f7f6f3]">
        <div className="max-w-6xl mx-auto">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] block mb-4">
            How it works
          </span>
          <h2
            className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-[#171716] mb-4"
            style={serif}
          >
            Three steps,<br />infinite tasks.
          </h2>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-6">
            <StepCard
              num="01"
              title="Tell it what you need"
              body="Plain English. No prompting tricks, no special syntax. Just describe what you want done."
            />
            <StepCard
              num="02"
              title="zWork reads and acts"
              body="It finds the right files, reads what's needed, and works through the task step by step on your machine."
            />
            <StepCard
              num="03"
              title="You get finished work"
              body="Not a draft to clean up. A finished document, a sent email, a booked meeting — real output."
            />
          </div>
        </div>
      </section>

      {/* ---------- PRICING ---------- */}
      <section className="py-20 md:py-28 px-6 border-t border-[#e6e3dc] bg-white">
        <div className="max-w-6xl mx-auto">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] block mb-4">
            Pricing
          </span>
          <h2
            className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-[#171716] mb-3"
            style={serif}
          >
            Start free.<br />Scale when you're ready.
          </h2>
          <p className="text-lg text-[#6b6a65] max-w-xl mb-12">
            Self-host for free with your own API key, or upgrade to Cloud for a managed experience.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl">
            {/* Free */}
            <div className="rounded-2xl border border-[#e6e3dc] bg-[#f7f6f3] p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] mb-2">Free</div>
              <div className="flex items-baseline gap-2 mb-6">
                <span className="text-4xl font-semibold tracking-tight text-[#171716]">$0</span>
                <span className="text-[13px] text-[#6b6a65]">forever · self-hosted</span>
              </div>
              <ul className="space-y-3 mb-8">
                <CheckItem text="Full agent capabilities" />
                <CheckItem text="Bring your own API key" />
                <CheckItem text="All integrations included" />
                <CheckItem text="Private, runs locally" />
                <CheckItem text="Community support" />
              </ul>
              <a
                href="/download"
                className="inline-flex items-center gap-2 rounded-full bg-[#171716] px-5 py-2.5 text-[13px] font-semibold text-[#f7f6f3] hover:bg-[#25241f] transition-colors"
              >
                Download now
              </a>
            </div>

            {/* Pro */}
            <div className="rounded-2xl border-2 border-[#171716] bg-[#171716] p-8 relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#171716] text-[#f7f6f3] text-[10px] font-semibold uppercase tracking-[0.15em] px-3 py-1 rounded-full">
                Most popular
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] mb-2">Pro</div>
              <div className="flex items-baseline gap-2 mb-6">
                <span className="text-4xl font-semibold tracking-tight text-[#f7f6f3]">$12</span>
                <span className="text-[13px] text-[#a09e98]">per month</span>
              </div>
              <ul className="space-y-3 mb-8">
                <CheckItemLight text="Everything in Free" />
                <CheckItemLight text="No API key needed" />
                <CheckItemLight text="Cloud sync across devices" />
                <CheckItemLight text="Persistent memory" />
                <CheckItemLight text="Priority support" />
              </ul>
              <a
                href="#"
                className="inline-flex items-center gap-2 rounded-full bg-[#f7f6f3] px-5 py-2.5 text-[13px] font-semibold text-[#171716] hover:bg-white transition-colors"
              >
                Join the waitlist
              </a>
            </div>

            {/* Team */}
            <div className="rounded-2xl border border-[#e6e3dc] bg-[#f7f6f3] p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] mb-2">Team</div>
              <div className="flex items-baseline gap-2 mb-6">
                <span className="text-4xl font-semibold tracking-tight text-[#171716]">$40</span>
                <span className="text-[13px] text-[#6b6a65]">per month · per seat</span>
              </div>
              <ul className="space-y-3 mb-8">
                <CheckItem text="Everything in Pro" />
                <CheckItem text="Team workspace & sharing" />
                <CheckItem text="Admin controls & roles" />
                <CheckItem text="Usage analytics dashboard" />
                <CheckItem text="Dedicated support channel" />
              </ul>
              <a
                href="mailto:hello@zwork.ai"
                className="inline-flex items-center gap-2 rounded-full bg-[#171716] px-5 py-2.5 text-[13px] font-semibold text-[#f7f6f3] hover:bg-[#25241f] transition-colors"
              >
                Contact us
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- GET STARTED ---------- */}
      <section className="py-20 md:py-28 px-6 bg-[#171716]">
        <div className="max-w-3xl mx-auto text-center">
          <h2
            className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-[#f7f6f3] mb-4"
            style={serif}
          >
            Your computer should<br />do more for you.
          </h2>
          <p className="text-lg text-[#a09e98] max-w-xl mx-auto mb-8">
            Download zWork free and open source. No account, no API key setup needed to try it.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="/download"
              className="inline-flex items-center gap-2 rounded-full bg-[#f7f6f3] px-6 py-3 text-[14px] font-semibold text-[#171716] hover:bg-white transition-colors"
            >
              Download for free →
            </a>
            <a
              href="https://github.com/Ryz3nPlayZ/zWork"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-[#2d2d31] px-6 py-3 text-[14px] font-medium text-[#a09e98] hover:text-[#f7f6f3] hover:border-[#4a4a4e] transition-colors"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

/* ---------- Sub-components ---------- */

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-xl font-semibold tracking-tight text-[#171716] mb-2" style={serif}>
        {title}
      </h3>
      <p className="text-[14px] text-[#6b6a65] leading-relaxed">{body}</p>
    </div>
  );
}

function StepCard({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <div className="relative">
      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98] mb-3">{num}</div>
      <h3 className="text-xl font-semibold tracking-tight text-[#171716] mb-2" style={serif}>
        {title}
      </h3>
      <p className="text-[14px] text-[#6b6a65] leading-relaxed">{body}</p>
    </div>
  );
}

function CheckItem({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2.5 text-[14px] text-[#25241f]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-600 shrink-0 mt-0.5">
        <path d="M20 6L9 17l-5-5" />
      </svg>
      {text}
    </li>
  );
}

function CheckItemLight({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2.5 text-[14px] text-[#f7f6f3]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400 shrink-0 mt-0.5">
        <path d="M20 6L9 17l-5-5" />
      </svg>
      {text}
    </li>
  );
}
