# zWork intro film: the brief

The prompt I wrote for myself before building anything. It follows the
`product-launch-motion` skill's prompt format (inputs, direction, structure, build, gotchas). I also
used what I found researching how people make SaaS launch films with Opus 5.5: one takeaway per
scene, the same object carried across every transition, text held for at least 1.2 s, a pause before
each reveal, a contact sheet before the full render, then a critical second pass.

Sources: `docs/POSITIONING.md`, `design.md`, `docs/LANDING_DESIGN.md`, `site/src` (hero,
statement, capabilities horizon, app clone, demo scenarios).

---

```
<role>
You are the director and motion designer of a 36-second intro film for zWork. Make every creative
call yourself, log each one as a DECISION, and list them at the end.
</role>

<inputs>
States: director's cut, listed below. Palette: zWork's locked system (parchment and ink, monochrome
accent, green only for done). Score: director picks. Use an original score synthesized in numpy at
120 BPM in D minor, with a real arc: a quiet intro, a snare build, a drop, a breakdown, and a
soft, swelling ending.
</inputs>

<takeaway>
"zWork does the paperwork I redo every week on my own computer. I get back a real Excel file, it
asks before anything is sent, and it repeats every Friday." Price and platforms come at the end.
</takeaway>

<audience>
Non-technical people who pay for their own tools: solo owners, bookkeepers, office managers.
No terminal, no "ran python script", no model names, no "200+ providers". Plain words only.
</audience>

<direction>
One shape, never cut. A single parchment card is the protagonist. It becomes, in order: a clock pill, a
CSV file chip, the zWork composer, the run card, an Excel sheet, a permission sheet, a toast, a
schedule toggle, and a wall of Fridays, and it ends as the zWork mark. Every change is that card
springing its size, radius and fill. Content swaps with a short blur, exit short and early.

The camera keeps each state filling the frame: push in on the composer, pull back on the wall of
Fridays to show scale.

Two cursors. "You" is the human: an ink arrow with a paper name pill that types and clicks Allow.
"zWork" is the agent: an ink arrow whose pill carries the six-slat mark. It takes over at the drop.
At the end its mark flies to center and becomes the logo. That last move is the cursor becoming
the logo.

Look: parchment #F2F0E8 canvas with the site's 22 px dot grain, ink #302E28, raised #EAE8E0,
sunken #F6F4EC, line #DAD6CA, success #10B981 for checks only. Instrument Serif for display lines
(the site's hero voice, with an italic "done."). Inter for UI. The ending falls into the site's
graphite horizon (#141416, cream #EEEEEC) so it lands like the capabilities section.

Banned: bouncy easing, particles, glows on UI (background light pools and the
logo's soft halo are allowed, revised after the first cut), gradients on UI chrome, neon, fake dashboards, model
names, developer framing, dead time, template looks, and copying site copy wholesale. The hero
headline is the one exception, since it is the tagline.
</direction>

<structure>  (120 BPM, beat = 0.5 s, bar = 2 s, 18 bars)
Bars 1–2   0–4 s    HOOK. A clock pill reads "Friday · 4:47 PM", ticks once per beat, and a serif line
                    rises: "Your weekly" over a word that swaps each beat: invoices, reports, payroll,
                    expenses.
Bars 3–4   4–8 s    THE MESS. The pill becomes the file chip bank_export_q3.csv. It cracks open into
                    the raw rows behind it: three date formats, AMZN MKTP vs Amazon.com, a duplicate
                    row. The camera drifts across. Caption: "The same mess. Every week."
Bars 5–7   8–14 s   THE ASK (snare build). The rows fold back into the chip and the chip docks
                    into the zWork composer as an attachment. "You" types on 16ths with a keytick
                    on each: "Turn this into the Q3 expense report." The send button presses on
                    beat 27.5.
Bars 8–10  14–20 s  THE DROP. The composer becomes the run card and the zWork cursor takes over.
                    Plain-language steps check in on the beat: Read 87 transactions, Fixed 3 date
                    formats, Merged 17 vendor names, Removed 1 duplicate, Sorted every line into
                    a category. An odometer rolls to $43,687.78.
Bars 11–12 20–24 s  REAL FILE. The card unfolds into q3_expenses.xlsx: header row, frozen pane,
                    category column, totals, a bar that draws itself, and an "Open in Excel" chip.
Bars 13–14 24–28 s  ASKS FIRST. The sheet folds into a permission sheet: "Send to Priya? Q3 expense
                    report, 1 attachment." Deny / Allow. The zWork cursor waits beside it, "You"
                    clicks Allow, and it becomes the toast "Sent to Priya".
Bars 15–16 28–32 s  EVERY WEEK. The toast becomes a schedule row, "Every Friday at 4:00 PM", and
                    the cursor flips the toggle so the knob stretches. Pull back: the row becomes one
                    of 12 Friday tiles in a wall, each checking in on 16ths.
Bars 17–18 32–36 s  LOGO. The canvas falls to graphite and the wall collapses to center. The
                    zWork cursor's mark grows to center, then replays the site's preloader:
                    it rolls a full turn left into the lockup while a cream block wipes over
                    the wordmark slot and retracts right to reveal "zWork". Then
                    "Your weekly paperwork, done." Last line: "$12 a month · free with your own key ·
                    Mac, Windows, Linux". Hold until the score rings out.
</structure>

<truth>
Real: $12 Pro, free with your own key, Mac/Windows/Linux, works on your own files, asks before it
sends, schedules, real .xlsx output.
Invented micro-story, the same one the site's demo tells: Q3 export, 87 rows, $43,687.78, Priya.
Say which is which in the report.
</truth>

<build>
1. One HTML file, 1920×1080. Every style comes from time inside seek(t): no CSS transitions, no
   timers, no state carried between frames.
2. Use closed-form springs (stepR) and Tracks that sum one spring per target change. Damping is
   0.75–0.9 for UI and 1.0 for the camera and text.
3. The toggle knob uses an edge-split stretch, with the leading edge on the stiffer spring.
4. Cursors: velocity lean, a press scale of 1 − 0.16·exp(−((t−tc)/0.045)²), and a 0.4 s ripple.
5. The score and SFX are synthesized in numpy. SFX cues are exported from the film's own cue list
   (one source of truth), and each sound is placed so its peak lands on its cue.
6. Render with Playwright Chromium, 4 subframes per frame, ffmpeg tmix motion blur, 60 fps H.264,
   then mux AAC.
7. Before the full render, make a contact sheet of one frame per beat and fix anything cramped,
   empty, overlapping or unreadable. Then check every transition at ±0.1 s.
8. Critic pass: assume the first cut is not final. Fix the three worst problems and re-render.
</build>

<gotchas>
No will-change on anything the camera scales. A spring that must arrive at T is issued one
settle-lead early. Text inside a morphing container gets its own vis() window. Odometer slots are
sized to their final glyph and clipped only vertically. Fonts must be loaded before the first frame
is captured (wait on document.fonts.ready).
</gotchas>
```
