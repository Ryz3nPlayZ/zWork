# Competitors, use cases, and launch readiness — 2026-10-25

Mission: bring agentic intelligence to non-technical people. Wedge (POSITIONING.md):
the $12 agent that finishes recurring office paperwork on your own computer.

Every "zWork" grade below was checked in this branch (`site/redesign`); file
references are given where it matters. "Not run" means it was read in code, not exercised.

---

## 1. Competitor landscape (October 2026)

| Product | Price to get the agent | Runs where | Office output | Schedules | Notes |
|---|---|---|---|---|---|
| **ChatGPT Work** (replaced agent mode 2026-07-09) | **Free: limited Work on desktop**; Plus $20 expanded + scheduled tasks | Cloud + desktop app (Mac/Win) with local files, apps, browser, computer use | Finished docs/sheets/slides/Sites; Excel/Word/PPT/Sheets extensions | Once / scheduled / event-triggered / continuous (event triggers not on Free/Go) | 1,400+ plugins, plan mode with approvals. Atlas shut down 2026-08-09. |
| **Claude Cowork** | All paid plans (Pro ~$20) | **Cloud-first since 2026-10-06**; local files/computer use need desktop app open | Claude for Excel/Word/PowerPoint GA 2026-05-07, Outlook beta | Run with no device online | Computer use beta on Pro/Max. |
| **Microsoft Copilot** | Agent Mode in Word/Excel (commercial GA ~Apr 2026; consumer via Frontier); Business ~$21, Enterprise $30 | Inside Office; Copilot Cowork GA 2026-06-16 ($0.01/credit) | Native — edits the real file | Cowork tasks | Windows local-file agent shown 2026-10-07 (rename/move/act in apps, approval before data leaves device), rollout TBD. |
| **Google Gemini** | Spark (24/7 Gmail agent): AI Ultra only, US; Pro $19.99 | Cloud | Workspace-native | Always-on | Pichai: "eventually free". Bundled in Workspace. |
| **Manus** | $20 / 4,000 credits, $40 | Cloud VM | Docs, slides, sites | Yes | Independent again (Meta deal blocked). Trustpilot 1.2 — billing complaints. |
| **Perplexity** | Comet free; Computer on Max $200 | Browser / cloud | Light | Tasks | Research-first. |
| **Genspark** | Plus ~$24.99, Pro ~$249.99, credits | Cloud | AI Slides/Sheets/Docs | Yes | "Call For Me" phone calls. |
| **Lindy** | $49.99–$199.99, no free tier | Cloud | — | Yes | Inbox drafting, meeting scheduling, computer use on Pro. |
| **Zapier / Relay / Make / n8n** | Free–$30 | Cloud | — | Core feature | Workflow builders; Relay has approval gates. Not "do it for me". |
| **Notion Custom Agents** | Business/Enterprise, credits | Cloud | Notion pages | Yes | Locked to Notion. |
| **Simular** | $50 / $200 / $500 | Cloud Win/Mac computer | Via apps | Yes | Pure computer use. |
| **OpenClaw** | Free, BYOK | Local | Via skills | Routines | Huge OSS following; chat via WhatsApp/Telegram/iMessage; security concerns. |
| **Hermes Desktop** (Nous), OpenWork, Eigent, Open Cowork, OpenWorker | Free, BYOK | Local | Varies | Some | Developer-leaning OSS. |
| **TRAE Work / QoderWork / WorkBuddy, Kimi OK Computer, MiniMax Agent** | $3–$120; TRAE free tier allows BYOK | Cloud/desktop | Docs/slides | Some | Price pressure from below. |
| **Vertical:** Xero JAX, QuickBooks agents, Dext AI Assist | Inside the ledger | Cloud | — | Yes | Bookkeepers' tools already have agents. |

### What changed versus POSITIONING.md

1. **"Cheapest real agent" is no longer true.** ChatGPT Free ships limited desktop Work, and TRAE's free tier allows BYOK. Price alone is no longer our moat.
2. **Cowork going cloud-first helps our local angle.** "Your files never leave your computer, any model, $12" is now a real difference from Claude, and a softer one against ChatGPT, whose desktop Work still sends file contents to OpenAI.
3. **Rivals now keep working when the laptop is off.** Both leaders run schedules with no device online, and zWork does not, so P2 #9 (cloud runner) is closer to P1.
4. **Office-native agents are mainstream.** Microsoft and Anthropic both edit the real Excel or Word file. Handing back an unverified .xlsx is now below the bar.

---

## 2. ICPs and every reasonable use case, graded

Legend:
- ✅ **works**: the capability exists end to end.
- 🟡 **partial**: it works, with caveats or only via a fragile path.
- ❌ **missing**: no path exists.

### Shared capability base (what grades rest on)

| Capability | State | Evidence |
|---|---|---|
| Read PDF/Word/Excel/PowerPoint/scans | ✅ | `tools/doc_extract.rs`, OCR on all 3 OSes |
| Create docx/xlsx/pptx/pdf/charts | ✅ create · ❌ verify | Managed runtime installs python-docx, openpyxl, python-pptx, pypdf, reportlab, matplotlib (`runtime.rs:23`) |
| Excel formulas actually compute / no #REF! | ❌ | `xlsx/SKILL.md` says recalc is **MANDATORY** via `scripts/recalc.py`, but **no skill scripts ship** (all 4 Office skill dirs contain only SKILL.md; 9 referenced scripts missing). LibreOffice isn't bundled or installed. |
| Gmail, Google Calendar, Drive, Slack, Notion, HubSpot | ✅ | Composio catalogue (`connectors/composio.rs:169`, cloud `main.rs:6183`) |
| Outlook, OneDrive, Excel Online, Teams | ❌ | Not in the 12-app catalogue |
| QuickBooks, Xero, Stripe, Shopify, Etsy, DocuSign, Dropbox | ❌ | Not in catalogue (Composio supports most of them) |
| General web search | 🟡 | `web_search` = Google News RSS only (`tools/search.rs:36`); real search needs the Chrome extension or computer use |
| Fill web forms / portals | 🟡 | Chrome bridge (needs Chrome + extension) or computer use (slow, permission prompts) |
| Desktop apps (computer use) | 🟡 | macOS solid; Windows CI real-driver test green; Linux untested |
| Recurring jobs | 🟡 | Scheduler + close-to-tray + one catch-up run at startup (`scheduler.rs:64`); **no launch-at-login**, nothing runs while asleep |
| Approve before sending | 🟡 | Permission prompts in-session; not verified for unattended scheduled runs |
| Audio / meeting transcription | ❌ | No speech-to-text anywhere |
| Phone calls, SMS | ❌ | — |
| Mobile / remote access | ❌ | Desktop only |
| Memory, projects with context | ✅ | `memory.rs`, project `context.md` |

### By ICP

**Solo owner / freelancer**

| Use case | Grade |
|---|---|
| Invoice from a timesheet or emails → PDF | 🟡 Works, but totals are not verified |
| Chase unpaid invoices by email | 🟡 Gmail only |
| Collect receipts → expense sheet | 🟡 Gmail only; sheet not verified |
| Quote/proposal from template | ✅ |
| Weekly inbox triage + drafts | ✅ Gmail only |
| Book meetings | ✅ Google Calendar |
| Social post drafts | ✅ |
| Sync to QuickBooks or Xero | ❌ |

**Bookkeeper / small practice**

| Use case | Grade |
|---|---|
| Bank CSV → categorised ledger | 🟡 Not verified |
| Statement-to-ledger reconciliation | 🟡 Not verified, and accuracy is the whole job |
| Monthly client reports | 🟡 |
| Chase clients for documents | 🟡 Gmail only |
| Post to QuickBooks or Xero | ❌ Competes with Xero JAX, which already does this |

**Office / ops manager (2–50 people)**

| Use case | Grade |
|---|---|
| Rename and file scans | ✅ |
| Mail-merge letters | ✅ |
| Supplier price-list comparison | 🟡 |
| Onboarding packet | ✅ |
| Weekly status report from Drive/Slack | ✅ |
| Anything in Outlook, OneDrive, Teams | ❌ Most firms of this size run on Microsoft 365 |

**EA / admin**

| Use case | Grade |
|---|---|
| Daily email digest | ✅ Gmail only |
| Calendar juggling | ✅ Google only |
| Travel research | 🟡 Search is weak |
| Meeting notes → action items | ❌ No transcription; works only if a transcript is supplied |
| Expense reports | 🟡 |

**Real estate agent**

| Use case | Grade |
|---|---|
| Listing description from photos and notes | ✅ |
| CMA spreadsheet | 🟡 Not verified, search is weak |
| Fill offer PDFs | 🟡 Fillable PDF via pypdf; not tested |
| Lead follow-up emails | ✅ |
| Send for e-signature | ❌ |

**E-commerce seller**

| Use case | Grade |
|---|---|
| Product descriptions in bulk from CSV | ✅ |
| Inventory/sales report | 🟡 Manual export needed |
| Customer-email replies | ✅ Gmail only |
| Anything inside Shopify, Etsy or Amazon | ❌ Only possible via computer use |

**Recruiter / HR**

| Use case | Grade |
|---|---|
| Screen résumés against a JD into a shortlist sheet | ✅ |
| Offer letters (mail merge) | ✅ |
| Interview scheduling | ✅ Google only |
| Policy handbook | ✅ |

**Teacher**

| Use case | Grade |
|---|---|
| Lesson plans, worksheets, quizzes as docx/pptx | ✅ |
| Grade a stack of submissions against a rubric into a gradebook sheet | 🟡 Not verified |
| Parent emails | ✅ |

**Student**

| Use case | Grade |
|---|---|
| Notes and study guides from PDFs | ✅ |
| Slides | ✅ |
| Citations | ✅ academic tools |
| Lecture recordings | ❌ |

**Nonprofit coordinator**

| Use case | Grade |
|---|---|
| Donor thank-you mail merge | ✅ |
| Grant report from a spreadsheet | 🟡 |
| Volunteer schedule | ✅ |

**Job seeker**

| Use case | Grade |
|---|---|
| Tailor CV and cover letter per posting | ✅ |
| Track applications in a sheet | ✅ |
| Find postings | 🟡 Search is weak |
| Auto-apply on portals | 🟡 Computer use, fragile |

**Personal life admin**

| Use case | Grade |
|---|---|
| Sort the Downloads folder | ✅ |
| Household budget from bank CSVs | 🟡 |
| Fill government or insurance PDF forms | 🟡 |
| Compare insurance quotes | 🟡 Search is weak |
| Bill reminders | 🟡 Only while the laptop is awake |

**What the grades show:** zWork can already *make* almost every document these
people need. It falls short in three places:
- it does not *prove the document is right*;
- it cannot reach the *Microsoft and accounting apps* half the ICP lives in;
- it does not *run when nobody is watching*.

---

## 3. What blocks launch — ranked

### Hard blockers (a non-technical user fails or leaves)

1. **Unsigned installers.** The only release secret set is `TAURI_SIGNING_PRIVATE_KEY`, the updater key.
   - The release workflow warns that macOS ships **unsigned and not notarized**: Gatekeeper reports an "unidentified developer" or "damaged" app.
   - Windows ships **unsigned**: SmartScreen shows "Windows protected your PC".
   - Non-technical users stop at these screens.
   - Fix: get an Apple Developer ID ($99/yr) and notarize; get a Windows OV/EV certificate or use Azure Trusted Signing (~$10/mo). Add the secrets in `.github/workflows/release.yml:77-94`.
2. **The Office skills tell the model to run scripts that don't exist.**
   - The xlsx, docx, pptx and pdf `SKILL.md` files reference `scripts/recalc.py`, `scripts/office/{pack,unpack,validate,soffice}.py`, `thumbnail.py`, `comment.py`, `accept_changes.py` and `with_server.py`.
   - None of these ship, and LibreOffice is assumed but not present.
   - Every spreadsheet job hits a missing-file error, or the model claims success anyway. This breaks the core of the wedge and is P0 #1.
   - Fix: ship the scripts from the upstream skills repo. Then either install a headless recalculation engine in the managed runtime (LibreOffice is big, ~300 MB; the `formulas` Python package is a lighter option for evaluate-and-check) or cut the recalc instruction to an openpyxl formula-error scan.
3. **No Microsoft 365 or accounting connectors.**
   - The catalogue is 12 apps hard-coded in two places (`connectors/composio.rs:169`, `cloud-src/api/src/main.rs:6183`). Five of them are developer tools: GitHub, Jira, Linear, Trello, Todoist.
   - Fix: add Outlook, OneDrive, Excel, Teams, QuickBooks, Xero, Shopify, Stripe and Dropbox. Swap the dev tools out of the default grid.
   - Effort: about one line per app in each list, plus a Composio auth config per app. This is cheap and closes P0 #2.

### Product blockers (it works, but feels like a developer tool)

4. **The agent is configured for developers.**
   - `include_academic = true` is hard-coded (`agent/harness_turn.rs:1657`).
   - Every run sends 42 native tools, plus 7 coding tools (bash, grep, find…), plus all Composio and MCP tools.
   - Estimated prompt size before the user types anything: ~18k characters of template plus ~32k characters of tool schemas, against the target of under 15k characters and under 25 tools.
   - The prompt talks about "install packages, run servers".
   - Bundled skills include claude-api, mcp-builder, webapp-testing, algorithmic-art and slack-gif-creator.
   - Result: higher cost per run, worse tool choice, and dev-flavoured replies. This is P0 #3.
   - Fix: a product mode that drops the academic, deploy, Telegram, stock and spawn_agent tools and the dev skills unless the user turns them on.
5. **Onboarding is a personality quiz, not a first win.**
   - Questions: vibe, verbosity, "Launch a startup / Graduate", then an API-key step.
   - There are no job templates (P0 #4).
   - Fix: replace the quiz with "Pick a chore you do every week" (6 templates matched to section 2), run it on a sample file, and show the finished file. Keep BYOK behind "Advanced".
6. **Web search returns news headlines only.**
   - "Find this vendor's address" or "compare these prices" fails unless the Chrome extension is set up. ChatGPT Free does this out of the box.
   - Fix: route `web_search` through the hosted router (Brave, Exa or Tavily) for signed-in users.
7. **Schedules silently miss runs.**
   - There is no launch-at-login, and nothing runs while the machine is asleep.
   - At startup the scheduler catches up only once, and the user isn't told what was missed.
   - Fix now: launch at login (`tauri-plugin-autostart`), plus an inbox note saying "missed Monday's run, ran it now".
   - Later: a cloud runner for connector-only jobs.

### Launch operations

8. **Pending, not approved:**
   - the gateway deploy (Sol reasoning fix plus the flash routing order);
   - the v0.6.1 tag and publish.
9. **Not yet verified:**
   - Linux real computer-use driver;
   - unattended approvals (what happens to a scheduled run that wants to send an email while nobody is there).
10. **Positioning copy:** POSITIONING.md still says ChatGPT has no cheap agent. Rewrite the pitch around:
    - local and private ("your files never leave your computer");
    - finished and checked ("we prove the spreadsheet adds up");
    - $12.

    The pitch should not lead with "cheapest".

### Already fine

- Legal pages are live (tryzwork.app/privacy and /terms both return 200).
- No stale `zwork.ai` references remain in shipped code.
- Feature parity across platforms is done.
- The managed Python/Node runtime works on all three OSes.

---

## 4. Suggested launch order

| Order | Item | Size |
|---|---|---|
| 1 | Signing + notarization (#1) | External accounts, ~1 day of setup |
| 2 | Ship the Office skill scripts + add a formula check (#2) | Small–medium |
| 3 | Microsoft, accounting and commerce connector tiles (#3) | Small |
| 4 | Product mode trims tools, prompt and skills (#4) | Medium |
| 5 | Chore-template onboarding (#5) | Medium |
| 6 | Hosted web search (#6), autostart and missed-run notice (#7) | Small each |

Defer: cloud runner, transcription, phone calls, mobile access, e-signature.

---

## Sources

Read via web search/fetch on 2026-10-24–25; listed by site. Prices and plan details move fast, so recheck before quoting them publicly.

- Claude Cowork: support.claude.com/en/articles/15520349
- Claude for Excel/Word/PowerPoint GA: claude.com/blog (2026-05-07)
- ChatGPT Work: help.openai.com (ChatGPT Work article); chatgpt.com/pricing (read 2026-10-24)
- Microsoft Copilot Agent Mode, Office Agent, Copilot Cowork: microsoft.com/microsoft-365/blog; techcommunity.microsoft.com
- Windows Copilot local-file agent: blogs.windows.com (2026-10-07)
- Gemini Spark / AI Ultra pricing: blog.google; gemini.google/subscriptions
- Manus: manus.im/pricing; trustpilot.com/review/manus.im
- Perplexity Comet / Computer: perplexity.ai/pro
- Genspark: genspark.ai/pricing
- Lindy: lindy.ai/pricing
- Zapier / Relay / Make / n8n: their /pricing pages
- Notion Custom Agents: notion.com/pricing
- Simular: simular.ai/pricing
- OpenClaw, Hermes Desktop, OpenWork, Eigent, Open Cowork, OpenWorker: their GitHub repositories
- TRAE / Kimi / MiniMax: trae.ai/pricing, kimi.com, minimax.io
- Xero JAX, QuickBooks agents, Dext: xero.com, quickbooks.intuit.com, dext.com
