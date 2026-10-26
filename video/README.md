# Making motion-graphics videos (for agents)

How to make a 20–60 s product launch or intro film for any product, rendered to MP4 from HTML.
It was written after making the zWork intro film (`launch/`), which is the worked example. Read this
first. Then read the files it points to, in the order given.

## 1. Read these first

| What | Where | Why |
|---|---|---|
| The skill | `~/.claude/skills/product-launch-motion/` (`SKILL.md`, `references/prompts.md`, `references/technique.md`) | The creative rules and the core technique. Load it with the Skill tool before anything else |
| A worked brief | [launch/BRIEF.md](launch/BRIEF.md) | The prompt written before any code: role, takeaway, audience, look, a beat-by-beat structure, real vs invented data, build rules |
| A worked film | [launch/film.html](launch/film.html) | One HTML page with a pure `seek(t)`: springs, camera, cursors, blur swaps, cue list |
| The pipeline | [launch/render.mjs](launch/render.mjs), [launch/audio.py](launch/audio.py), [launch/verify.sh](launch/verify.sh) | Render, sound and checks. Copy them; don't rewrite them |

If the skill is missing, install it:
```bash
npx -y skills add AbubakrChan/product-launch-motion -g -a claude-code -y
```
The Remotion skills (`npx -y skills add remotion-dev/skills -g -a claude-code -y`) are an
alternative. We didn't use them: a plain HTML page with a pure `seek(t)` is simpler and gives
full control.

## 2. Process

1. **Study the product before inventing anything.** Read its positioning doc, design system and
   landing page code, and its app UI if there is one. Extract:
   - the palette and fonts, from the real tokens
   - the logo, as SVG
   - the one-sentence takeaway for the viewer
   - the audience, which decides the wording (non-technical buyers get no jargon)
   - the micro-story the site already tells (sample data, names, numbers)

   Copy the brand's own motion too. Its landing page opener or logo animation is the best model for
   the film's logo moment. In zWork's case the user wanted the ending to replay `site/src/sections/Preloader.tsx`
   exactly: a back.out(2.2) pop to 1.45×, a −360° roll into the lockup, then a block wipe over the wordmark.
2. **Write the brief** (`BRIEF.md`) in the skill's format before any code. Set the BPM and the bar
   grid first (120 BPM gives 0.5 s beats and 2 s bars), then put every scene on bars. Choose the one
   shape that morphs through every state.
3. **Build `film.html`.** Every style must be a function of `t` inside `seek(t)`. No CSS
   transitions, no timers, no state between frames. Register every sound with `cue(t, kind, value)`.
4. **Export cues and make the audio:**
   ```bash
   node events.mjs && python3 audio.py
   ```
   Check the loudness of `mix.wav`. Aim for −16 to −17 LUFS integrated, with true peak below −0.5 dBFS.
5. **Check stills before rendering.** Run `snap.mjs` at the beats and transitions you care about,
   tile them with `sheet.py`, then look at them with Read. Fix anything that's cramped, empty,
   overlapping or unreadable. Then check every transition at ±0.1 s.
6. **Draft render** (fast, half size):
   ```bash
   node render.mjs qa/draft.mp4 --scale 0.5 --fps 30 --sub 1 --draft
   ```
7. **Full render.** It takes 10–25 minutes, so run it in the background:
   ```bash
   node render.mjs deliver/<name>.mp4 --workers 9
   ```
8. **Verify the MP4 itself** with `./verify.sh deliver/<name>.mp4`. It prints the format and
   loudness, builds a 1-per-second storyboard, lists the largest frame-to-frame jumps (to catch
   seams and flicker) and saves key stills. Look at the storyboard.
9. **Critic pass.** Assume the first cut isn't final. Fix the three worst problems and re-render.
10. **Deliver.** Send the MP4 with SendUserFile, not just a path. Say plainly that the audio was
    measured but not heard; an agent can't listen.

## 3. Adapting the pipeline to a new film

Copy `launch/` to `video/<name>/` and change only these:
- `film.html`: everything about the film, including `M.DUR`. `events.mjs` and `audio.py` read the duration from it.
- `render.mjs`: `const DUR = 37.0` is hardcoded. Change it to match the film.
- `verify.sh`: the list of still times.
- `audio.py`: the score (key, chords, arc) and the sound for each cue kind.
- `fonts/`: copy the product's real webfonts (woff2). The film waits on `document.fonts.ready`.

Keep each film's `.gitignore` (node_modules, chunks, wav, drafts). Commit only the film's own folder.

## 4. Taste (what the user liked and disliked)

- **Logo endings:** smooth eased morphs, or the brand's own opener animation. **Not** the logo's
  parts lighting up one by one ("tacky"). **Not** the logo flying in from a corner. Pop it in at the centre.
- **Backgrounds:** subtle, on-palette light pools and gradients on light scenes are welcome. Add
  faint grain or dither so they don't band in H.264. The dark ending stays **flat**, with no glow
  behind the logo.
- **Sound:** sparse and soft. Rounded bell tones and muted taps, a little reverb, and the effects
  bus well under the music. Don't tick on every beat, and avoid hard hits ("slams"); a reversed
  swell into the ending works better. The score carries the rhythm, and effects mark only what the
  viewer sees happen.
- **Motion:** springs with a tiny overshoot at most, except where the brand itself uses a bounce,
  like the site's pop. Text gets its own enter and exit timing inside morphing containers.

## 5. Gotchas that cost time

- **Chromium for Playwright:** `npx playwright install chromium` can hang. If it does, unzip the
  downloaded archive by hand into `~/Library/Caches/ms-playwright/chromium-<build>/` and launch with
  `channel: 'chromium'`.
- **zsh doesn't word-split `$VAR`.** A list of times arrives as one argument. Pipe it instead:
  `echo 1.0 2.0 | xargs node snap.mjs qa/out 0.5`.
- **Single-line code:** never put a `//` comment in the middle of a line in `film.html`. It silently
  comments out the rest of the line (it once hid the wordmark). Use `/* */`.
- **Two transitions sharing a moment:** when a wordmark and a moving logo overlap in time, stagger
  them and give the text its own `vis()` window, or they collide.
- **`visibility`:** a child with `visibility: visible` shows even inside a hidden parent. Use `inherit`.
- **Audio:**
  - Pad before summing sounds of different lengths (`mx()` in `audio.py`).
  - A snare build can end up louder than the drop. Measure loudness per section.
  - Finish with a tanh limiter set to about 0.88 of full scale.
- **No `will-change`** on anything the camera scales, or text goes blurry.
- **A spring that must arrive by time T** is issued one settle-time early.
- **Slow renders:** a full render takes 10–25 minutes with 9 workers. Run it in the background and
  wait for the completion notice; don't poll.
