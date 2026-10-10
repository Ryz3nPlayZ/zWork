# Branding audit: why search answers call zWork a "local-only developer tool"

2026-10-09. Prompted by a Google AI answer saying zWork has no hosted models, runs "no cloud, no telemetry", and is for technical users (API keys, Ollama, MCP). None of that matches [POSITIONING.md](POSITIONING.md): recurring office paperwork for non-technical people, a free account on our hosted models, $12 Pro.

## Where the answer comes from

A web search for that wording turns up nothing written about zWork, so no outside source is saying it. The answer is pieced together from the public text we publish ourselves. The text a crawler can actually read says "developer, local, open source" much louder than "sign up, we host it":

| Source | What it says | Why it matters |
|---|---|---|
| GitHub README | brew/irm/curl install commands, "Run from source", "Tech: Tauri + React, Rust backend, Postgres cloud" | The GitHub page carries the most weight of anything we publish, and every crawler reads it as plain text |
| GitHub description | "free and open source AI coworker…", no topics | "Open source" is the first thing it says |
| tryzwork.app HTML | A 1.3 KB page shell; all the copy is drawn by JavaScript | Crawlers that don't run JS (most LLM crawlers) see only the `<title>` and meta description. Google does run JS, but later and less reliably ([Google: JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)) |
| Site copy | "Or your own key", "Or fully local… prompts never leave this computer", "Ollama (local)" in the providers list, an Open source section and page, an "MIT licensed" footer, an "Is it open source?" FAQ | When the page is read, these sit next to the hosted models with equal weight |
| Privacy policy | Hosted only as `legal/PRIVACY.md` on GitHub; talks about `secrets.json`, mode 0600, `~/.zwork`, loopback binding | It reads like an engineering document. It also says conversation content is "never transmitted to zWork's servers", which **is wrong for Cloud users**: zWork Flash/Pro go through our router. That one line is close to "no cloud" |
| Calls to action | Every button says "Download"; nothing says "Create a free account" | Nothing tells a reader the product is an account with hosted models |
| Internal briefs | `LANDING_PAGE_BRIEF.md` says "Privacy-first… Nothing gets sent to the cloud unless…" and "For developers" | Outdated; anyone working from it (people or agents) brings the old framing back |

## What to change, in order of impact

1. **README for users, not contributors.** Start with one line on what it is, a screenshot, "Download free → sign in → it runs on our hosted models", pricing, and a link to the privacy page. Move install scripts, run-from-source and the tech stack to `CONTRIBUTING.md` / `docs/DEVELOPER_GUIDE.md`.
2. **GitHub description and topics.** For example: "An AI assistant for the paperwork you redo every week: reports, spreadsheets, emails. Free account, $12 Pro." Add topics such as `ai-assistant`, `productivity`, `automation`, `excel`, `office`. Keep "open source" out of the first line.
3. **Crawlable site HTML.** Prerender the routes at build time (for example with `vite-plugin-prerender` or a small render-to-string script) so the hero, features, pricing and FAQ text are in the HTML file. Add `robots.txt`, `sitemap.xml` and an [`llms.txt`](https://llmstxt.org) that describes zWork the way POSITIONING.md does.
4. **Lead with the account.** Main CTA: "Start free" or "Create a free account" (download → sign-in is the flow). Hosted zWork Flash/Pro are the default story; "bring your own key" and "run it locally" go into one small "Advanced" line or an FAQ answer. The Open source section moves to the footer and the /open-source page.
5. **A plain-language privacy page at tryzwork.app/privacy.** Short, honest, in this shape:
   - what we keep (email, plan, usage counts for billing, anonymous product analytics, which you can turn off);
   - what passes through us (your messages go through our servers to the model provider when you use zWork models; we don't train on them and don't keep them after the reply / keep them for N days);
   - what never leaves your computer (your files, unless you attach them; your own API keys);
   - how to delete your account.

   Then fix the "never transmitted" sentence in `legal/PRIVACY.md` and point `PRIVACY_URL` at the new page. A clear, short policy *is* the privacy pitch; it doesn't need "local-only" to carry it.
6. **Retire the old briefs.** Done for `LANDING_PAGE_BRIEF.md` (deleted 2026-10-09; POSITIONING.md replaces it). `PRODUCT.md` still needs the same.

Steps 1, 2 and 5 are text edits and do the most. Search and AI answers pick up changes as pages are recrawled (days to weeks); Search Console's "Request indexing" on tryzwork.app speeds up Google.
