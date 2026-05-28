# zWork — Landing Page Design Brief

## Product

**zWork** is a desktop AI assistant that actually does your work. Not a chatbot that gives advice you have to act on — an agent that performs tasks on your computer: organizes your files, writes your documents, researches the web, and completes multi-step jobs while you watch.

**Tagline:** *The AI assistant that does jobs, not just answers questions.*

**The problem:** There's a growing gap in who gets to use powerful AI.

Developers and technical teams have **agentic tools** — AI that writes code, runs tests, deploys apps, and fixes bugs automatically. Tools like Cursor, Claude Code, and GitHub Copilot don't just suggest ideas. They *do the work*.

Everyone else is stuck in **chatbot ping-pong**. You ask ChatGPT or Claude for help, they give you a draft, a suggestion, or a step-by-step guide... and then *you* have to do it. Copy-paste the email. Create the spreadsheet. Move the files. Fill out the form. The AI gives advice. You do the labor.

**zWork closes that gap.** It brings agent power to normal people — knowledge workers, small business owners, students, marketers, writers, and anyone who wants the thing done, not another paragraph of suggestions.

**The promise:** Tell zWork what you want. It does it — on your computer, with your files.

---

## Target Audience

**Primary:** Non-technical knowledge workers who spend their day on a computer — but aren't developers.

- **Small business owners** managing invoices, contracts, customer lists
- **Marketing and ops people** doing research, creating reports, organizing campaigns
- **Students and researchers** writing papers, comparing sources, formatting documents
- **Writers and editors** drafting, editing, organizing drafts and research
- **Administrative professionals** handling scheduling, filing, correspondence, data entry

**Secondary:** Technical people who want AI to handle the boring stuff — organizing files, filling forms, writing boilerplate — so they can focus on hard problems.

**Not for:** People who just want a better chat interface. They have ChatGPT.

---

## The Core Insight

**ChatGPT tells you how. zWork does it.**

| What you ask | ChatGPT gives you | zWork gives you |
|--------------|-------------------|-----------------|
| "Compare three vacuum cleaners" | A paragraph of text | A side-by-side comparison sheet, saved to your computer |
| "Turn my meeting notes into a follow-up email" | A draft you copy-paste | An email draft, formatted and ready to send |
| "Organize my downloads folder" | Step-by-step instructions | Files sorted into folders, duplicates removed |
| "Research competitors for my pitch deck" | A list of bullet points | A structured research doc with sources, saved as a file |
| "Fill out this form with my info" | Advice on what to write | The form, filled out, ready to review and submit |

---

## Key Value Propositions

1. **Execution, not conversation** — zWork performs actions on your computer. It moves files, creates documents, fills forms, and runs tasks. It doesn't just talk about doing them.

2. **Works with your stuff** — Your files, your folders, your apps, your desktop. Not a web app that lives in a browser tab. zWork is on your machine.

3. **Privacy-first** — Your documents and data stay on your computer. Nothing gets sent to the cloud unless you choose to use the optional hosted features.

4. **Cross-platform** — Works on macOS, Windows, and Linux. Whatever computer you use.

5. **Simple pricing** — Start free. Upgrade when you need more power.

---

## Core Features (What Works Today)

| Feature | What it means for you |
|---------|----------------------|
| **Live task execution** | Watch zWork plan and execute tasks in real-time, step by step |
| **File & folder management** | Organize, move, rename, and sort your files automatically |
| **Document creation** | Write, edit, and format documents, spreadsheets, and presentations |
| **Web research** | Pull current information from the internet and compile it into useful formats |
| **Reusable workflows** | Save tasks that work well and run them again with one click |
| **Auto-updates** | The app keeps itself up to date automatically |

---

## Architecture (For the Design Team)

| Layer | Technology |
|-------|------------|
| **Desktop shell** | Tauri (Rust) |
| **Frontend** | React + Vite + Tailwind CSS |
| **Local AI engine** | Python + FastAPI sidecar |
| **Cloud (optional)** | Rust (Axum) + Better Auth + Postgres |

The app is a native desktop application, not a web app. The landing page is a separate web property.

---

## Brand & Visual Direction

### Existing Design System

The desktop app has an established **modern-minimal** design system:

**Color palette (Light mode):**
- Paper: `#F2F0E8`
- Ink (text): `#302E28`
- Accent: `#302E28` (same as ink — monochrome with warmth)
- Lines/borders: `#DAD6CA`

**Dark mode:**
- Paper: `#2A2A2E`
- Ink: `#DCDAD2`

**Typography:**
- Body: Inter / system sans-serif
- Editorial: Instrument Serif (onboarding only)
- Scale: 28px page titles, 14px body, 13px captions

**Motion:**
- Press effects (scale 0.97)
- 140ms hover transitions
- No scroll-triggered animations (this is app UI, not marketing)

**CTA style:**
- Primary: solid dark on light, rounded-lg/xl
- Secondary: outlined with border
- Never `text-white` — always `text-paper` on dark backgrounds

### Logo

- File: `app/public/zwork.svg`
- Monochrome, geometric mark
- The "z" is stylized with angular cuts
- Works on both light and dark backgrounds

### Genre

**Warm minimalism.** Not cold tech-blue. Not generic AI SaaS gradient-purple. Think: **Notion's restraint + Raycast's utility + a touch of craft.** The UI uses warm greys and creams, not stark white and black.

---

## Landing Page Sections Needed

### 1. Hero

**Headline options:**
- "Your AI assistant that actually works"
- "Stop chatting. Start doing."
- "The AI gap ends here."

**Subhead:** "While developers use AI that writes code and deploys apps, everyone else is stuck copy-pasting from ChatGPT. zWork brings agent power to your desktop — so you can get the work done, not just read about how to do it."

**CTA:** Download buttons (macOS, Windows, Linux)

**Visual:** A screenshot or demo video showing zWork organizing files, creating a document, or completing a task. Contrast with a ChatGPT screenshot showing just text.

### 2. The Gap (Problem/Solution)

**Headline:** "Two types of AI. Only one does the work."

**The divide:**
- **For developers:** AI writes code, runs tests, fixes bugs automatically
- **For everyone else:** AI writes paragraphs you still have to act on

**zWork is the bridge.** It brings agent power to normal people.

Use-case cards:
- **Research & compare** → "Compare three vacuum cleaners" → side-by-side sheet, saved as a file
- **Draft & create** → "Turn my notes into a follow-up email" → real draft, formatted and ready
- **Execute & organize** → "Clean up my downloads folder" → files sorted, duplicates removed

### 3. How It Works

3-step process:
1. **Ask** — Type what you want in plain English. No commands, no syntax.
2. **Watch** — See zWork plan and execute each step in real-time.
3. **Keep** — Review, edit, save, or rerun the result. It's on your computer.

### 4. Features Grid

6 features in a 2x3 or 3x2 grid:
- **Live task execution** — Watch it work, step by step
- **File & folder management** — Organize, sort, and clean up automatically
- **Document creation** — Write, edit, and format files
- **Web research** — Pull current info and compile it
- **Reusable workflows** — Save what works, run it again
- **Auto-updates** — Always has the latest features

Keep it utilitarian. Icon + title + one-line description.

### 5. Trust & Safety

- **Your data stays local** — Files, documents, and tasks happen on your machine
- **You control everything** — Review before anything is saved or sent
- **Transparent** — See every step zWork takes
- **Optional cloud** — Only use online features if you want to

### 6. Pricing

Three simple tiers. Monthly or annual billing (save 17% on annual).

| Tier | Price | What you get |
|------|-------|--------------|
| **Free** | $0 | Get started with local AI. 200 tasks per 5 hours. Perfect for trying it out. |
| **Pro** | $12/mo or $120/yr | Faster models, hosted AI gateway, up to 5 workers at once, advanced analytics, priority support. |
| **Max** | $50/mo or $500/yr | Maximum power. Up to 10 workers, priority processing, dedicated support. For heavy users. |

- Toggle between monthly/annual
- "Current plan" badge for active tier
- Stripe checkout
- Access code redemption
- Manage billing button for paid plans

### 7. Download / Install

- Platform buttons: macOS (.dmg), Windows (.exe), Linux (.AppImage)
- Version badge: v0.3.x
- One-line install for technical users: `./run.sh`

### 8. Footer

- Links: Docs, Roadmap, GitHub, Contributing, Security
- Minimal

---

## Tone of Voice

**Warm, direct, and human. No jargon, no buzzwords.**

- Say "It does it" not "It empowers you to achieve your goals"
- Say "Your files stay on your computer" not "Local-first data sovereignty"
- Say "Get the work done" not "Leverage agentic workflows"
- No: "AI-native," "agentic," "synergy," "paradigm shift"
- Yes: Simple, concrete, action-oriented language

**The user is the hero.** zWork is the tool that gets out of the way.

Examples:
- "zWork is for people who want the thing done, not another app to master."
- "Watch answers and activity appear live, as the agent works."
- "Open it, sign in, ask for something."

---

## Competitive Context

| What people use today | What they get | How zWork is different |
|-----------------------|---------------|------------------------|
| **ChatGPT / Claude** | Advice, drafts, suggestions | zWork performs the actions, not just gives text |
| **Notion AI** | Writing help inside documents | zWork works across your entire computer, not just one app |
| **Zapier** | Automated workflows between apps | zWork understands natural language and handles one-off tasks, not just pre-built automations |
| **Virtual assistants (human)** | Someone else does it... eventually | zWork is instant, always available, and works with your files directly |

---

## Assets Available

- **Logo:** `app/public/zwork.svg` (monochrome, scalable)
- **Screenshots:** Build from the app directly — the UI is in `app/src/`
- **Design system:** `design.md` — full color/tokens/spacing spec
- **Copy:** `README.md` — feature descriptions and value props
- **Docs:** `docs/WIKI.md`, `docs/ARCHITECTURE.md`

---

## Deliverables

1. **Desktop landing page** (primary)
2. **Mobile responsive** (secondary)
3. **Dark mode variant** (match the app's dark theme)

---

## Open Questions for Stakeholders

1. Do we want a video demo in the hero? (Recommended: screen recording showing zWork completing a real task vs ChatGPT giving advice)
2. Do we need a waitlist/signup, or just download CTA?
3. Any testimonials from early users?
4. SEO keywords: "AI that does work," "desktop AI assistant," "AI agent for everyone"
