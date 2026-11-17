# python3 audio.py → mix.wav
# Original score (120 BPM, D minor, Dm–Bb–F–C) and every UI sound, synthesized with numpy.
# SFX positions come from events.json, which is exported from film.html itself (one source of truth);
# each sound is shifted so its own peak lands on its cue.
import json, wave
import numpy as np

SR = 48000
EV = json.load(open('events.json'))
DUR = EV['DUR']
N = int(DUR * SR)
rng = np.random.default_rng(7)
BEAT = 0.5

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def tt(d): return np.arange(int(d * SR)) / SR
def noise(d): return rng.standard_normal(int(d * SR))
def hp(x, k=1):
    for _ in range(k): x = np.diff(x, prepend=0.0)
    return x
def lp(x, a):  # one-pole lowpass, a = coefficient (0..1, smaller = darker); a may be an array
    y = np.empty_like(x); s = 0.0
    a = np.broadcast_to(a, x.shape)
    for i in range(len(x)): s += a[i] * (x[i] - s); y[i] = s
    return y
def env_ad(t, a, d): return np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)

music = np.zeros((2, N + SR * 3))
sfx = np.zeros((2, N + SR * 3))

def add(bus, x, t0, pan=0.0, g=1.0):
    i = int(round(t0 * SR))
    if i < 0: x = x[-i:]; i = 0
    x = x[: max(0, bus.shape[1] - i)]
    l, r = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
    bus[0, i:i + len(x)] += g * l * x
    bus[1, i:i + len(x)] += g * r * x

def mx(*xs):  # sum sounds of different lengths
    y = np.zeros(max(len(x) for x in xs))
    for x in xs: y[:len(x)] += x
    return y

def put(x, t, pan=0.0, g=1.0):  # SFX: align the sound's own peak to t
    pk = int(np.argmax(np.abs(x)))
    add(sfx, x / (np.max(np.abs(x)) + 1e-9), t - pk / SR, pan, g)

# ───────────────────────── score ─────────────────────────
CHORDS = [[50, 53, 57], [46, 50, 53], [48, 53, 57], [48, 52, 55]]   # Dm Bb F C (voice-led)
ROOTS = [38, 34, 41, 36]
def bar_of(t): return int(t // 2)

def saw(f, t, nh=10, bright=4.0):
    y = np.zeros_like(t)
    for n in range(1, nh + 1):
        if f * n > 12000: break
        y += np.sin(2 * np.pi * f * n * t + n * 0.7) / n * np.exp(-(n - 1) / bright)
    return y

def pad_bar(notes, d, bright, rel=0.6, att=0.3):
    t = tt(d + rel)
    e = np.minimum(1, t / att) * np.where(t > d, np.exp(-(t - d) / (rel / 3)), 1.0)
    L = np.zeros_like(t); R = np.zeros_like(t)
    for m in notes:
        f = mtof(m)
        L += saw(f * 2 ** (-6 / 1200), t, bright=bright)
        R += saw(f * 2 ** (6 / 1200), t, bright=bright)
    return L * e, R * e

# Arc for the 100 s film: intro → build → drop as the phone rises (16) → groove under the talking
# sections → build → drop into the demo (36) → breakdown under the code peek (56–66) → lift into the
# map → outro groove under the stats → closing chord with the end card (95).
def sec(t):
    if t < 6: return 'intro'
    if t < 11: return 'names'
    if t < 16: return 'build'
    if t < 34: return 'mid'
    if t < 36: return 'build'
    if t < 56: return 'full'
    if t < 64: return 'break'
    if t < 66: return 'build'
    if t < 88: return 'full'
    if t < 89: return 'gap'
    if t < 95: return 'full'
    return 'end'
GAPS = [(15.75, 16.0), (35.75, 36.0), (65.75, 66.0), (88.5, 89.0)]
def in_gap(t): return any(a <= t < b for a, b in GAPS)
PADG = {'intro': (0.9, 2.6), 'names': (0.8, 3.0), 'build': (0.75, 4.0), 'mid': (0.62, 4.2), 'full': (0.72, 5.2), 'break': (0.95, 2.6), 'gap': (0.5, 3), 'end': (0, 0)}
END = 95.0
for b in range(int(END // 2)):
    t0 = b * 2.0
    g, br = PADG[sec(t0 + 0.01)]
    L, R = pad_bar(CHORDS[b % 4], 2.0, br, rel=0.5)
    add(music, L, t0, -0.35, 0.05 * g); add(music, R, t0, 0.35, 0.05 * g)
# ending chord: Dm(add9) swells in and rings out under the end card
L, R = pad_bar([38, 50, 53, 57, 64, 69], 4.0, 4.0, rel=1.4, att=0.18)
add(music, L, END, -0.3, 0.065); add(music, R, END, 0.3, 0.065)

def pluck(f, d=0.5, dec=0.16):
    t = tt(d); e = env_ad(t, 0.003, dec)
    return (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)) * e
PAT = [0, 1, 2, 3, 2, 1, 3, 1]
ARPG = {'intro': 0.9, 'names': 0.8, 'build': 0.85, 'mid': 0.62, 'full': 0.85, 'break': 0.95, 'gap': 0, 'end': 0}
arpL = np.zeros(N + SR * 3); arpR = np.zeros(N + SR * 3)
for k in range(int(END / 0.25)):
    t0 = k * 0.25
    if in_gap(t0): continue
    ch = CHORDS[bar_of(t0) % 4]; notes = [m + 12 for m in ch] + [ch[0] + 24]
    m = notes[PAT[k % 8]] + (12 if 89 <= t0 < END else 0)
    vel = 0.55 + 0.45 * ((k % 2) == 0)
    x = pluck(mtof(m)) * vel * ARPG[sec(t0)]
    i = int(t0 * SR); arpL[i:i + len(x)] += x; arpR[i:i + len(x)] += x
dl = int(0.375 * SR)
eL, eR = np.zeros_like(arpL), np.zeros_like(arpR)
eL[dl:] += 0.32 * arpR[:-dl]; eR[2 * dl:] += 0.22 * arpL[:-2 * dl]
music[0] += 0.075 * (arpL + eL); music[1] += 0.075 * (arpR + eR)

def kick(g=1.0):
    t = tt(0.5); f = 46 + 110 * np.exp(-t / 0.028)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * env_ad(t, 0.002, 0.26)
    x[:200] += hp(noise(200 / SR)) * 0.25 * np.exp(-np.arange(200) / 40)
    return x * g
def snare(g=1.0):
    t = tt(0.25)
    return g * (0.8 * hp(noise(0.25)) * np.exp(-t / 0.075) + 0.6 * np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.045))
def clap(g=1.0):
    t = tt(0.3); n = hp(noise(0.3)); e = np.zeros_like(t)
    for o in (0, 0.011, 0.022): e += (t >= o) * np.exp(-np.maximum(0, t - o) / 0.006)
    e += (t >= 0.03) * np.exp(-np.maximum(0, t - 0.03) / 0.09) * 0.7
    return g * n * e
def hat(g=1.0, open_=False):
    t = tt(0.3 if open_ else 0.06)
    return g * hp(noise(len(t) / SR), 2) * np.exp(-t / (0.09 if open_ else 0.018))
def bass(f, d, g=1.0):
    t = tt(d); e = env_ad(t, 0.006, 0.16)
    return g * (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * e

for k in range(int(END / 0.125)):
    t0 = k * 0.125; beat = (k % 4 == 0); eighth = (k % 2 == 0)
    if in_gap(t0): continue
    b = bar_of(t0); root = ROOTS[b % 4]; S = sec(t0)
    if S == 'names':
        if k % 8 == 0: add(music, kick(0.5), t0)
        if k % 4 == 2: add(music, hat(0.09), t0, 0.3)
        if k % 16 == 0: add(music, bass(mtof(root), 1.2, 0.16), t0)
    elif S == 'build':
        add(music, hat(0.05 + 0.04 * (k % 4 == 2)), t0, 0.35 if k % 2 else -0.2)
        if k % 8 == 0: add(music, kick(0.5), t0)
    elif S in ('mid', 'full'):
        G = 0.8 if S == 'mid' else 1.0
        if beat: add(music, kick(0.9 * G), t0)
        if beat and (k // 4) % 2 == 1: add(music, clap(0.3 * G), t0, 0.05)
        if k % 4 == 2: add(music, hat(0.13 * G, open_=True), t0, 0.25)
        elif not beat: add(music, hat(0.065 * G), t0, -0.25)
        if k % 2 == 0 and not beat: add(music, bass(mtof(root), 0.3, 0.26 * G), t0)
        if beat: add(music, bass(mtof(root - 12) * 2, 0.22, 0.12 * G), t0)
    elif S == 'break':
        if k % 16 == 0: add(music, kick(0.6), t0)
        if k % 16 == 10: add(music, kick(0.35), t0)
        if eighth and not beat: add(music, hat(0.06), t0, 0.2)
        if k % 8 == 0: add(music, bass(mtof(root), 0.9, 0.2), t0)

# builds: accelerating snare roll + riser into each drop
def build(t_end, d):
    t_s = t_end - d
    q = [t_s + x for x in np.arange(0, d * 0.4, 0.5)] + [t_s + x for x in np.arange(d * 0.4, d * 0.75, 0.25)] + [t_s + x for x in np.arange(d * 0.75, d - 0.25, 0.125)]
    for t0 in q:
        if t0 < t_end - 0.25: add(music, snare(0.07 + 0.2 * ((t0 - t_s) / d) ** 1.6), t0, 0.08)
    dd = d - 0.25; t = tt(dd); u = t / dd
    rz = lp(noise(dd), 0.02 + 0.5 * u ** 2.2) * (u ** 2.4) * 2.2
    rz += 0.25 * np.sin(2 * np.pi * np.cumsum(220 + 700 * u ** 2) / SR) * u ** 3
    add(music, rz, t_s, 0, 0.18)
build(16.0, 4.0); build(36.0, 2.0); build(66.0, 2.0)

# drop booms
def boom(d=1.4, f0=55):
    t = tt(d); f = f0 + 60 * np.exp(-t / 0.05)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ad(t, 0.002, d / 3.5)
for t0 in (16.0, 36.0, 66.0, 89.0): add(music, boom(1.2, 49), t0, 0, 0.5)
add(music, boom(2.2, 36.7), END, 0, 0.4)

tm = np.arange(music.shape[1]) / SR
gate = np.ones_like(tm)
for a_, b_ in GAPS: gate[(tm >= a_) & (tm < b_)] *= 0.12
gate *= np.clip((DUR - tm) / 1.2, 0, 1)
music *= gate

# reverb (exponential noise IR, FFT convolution)
def reverb(x, rt=1.8, wet=0.2):
    n = int(rt * SR); t = np.arange(n) / SR
    out = np.zeros_like(x)
    for c in range(2):
        ir = rng.standard_normal(n) * np.exp(-t / (rt / 6.9)); ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        L = 1 << int(np.ceil(np.log2(x.shape[1] + n)))
        y = np.fft.irfft(np.fft.rfft(x[c], L) * np.fft.rfft(ir, L), L)[: x.shape[1]]
        out[c] = x[c] + wet * y
    return out
music = reverb(music, 2.0, 0.22)
music *= np.vstack([np.where(tm < DUR, 1, 0)] * 2)

# ───────────────────────── sound design ─────────────────────────
PENTA = [62, 65, 67, 69, 72, 74, 77, 79, 81, 84, 86, 89]   # D minor pentatonic, D4 up
def sine(f, d, a=0.002, dec=0.1): t = tt(d); return np.sin(2 * np.pi * f * t) * env_ad(t, a, dec)
def bell(f, d=0.9, dec=0.35):
    t = tt(d); y = np.zeros_like(t)
    for r, g, k in ((1, 1, 1), (2.0, 0.45, 0.6), (3.01, 0.22, 0.4), (4.2, 0.1, 0.25)):
        y += g * np.sin(2 * np.pi * f * r * t) * env_ad(t, 0.002, dec * k)
    return y
def whoosh(d=0.4, bright=0.25):
    t = tt(d); u = t / d
    e = np.sin(np.pi * np.clip(u / 0.8, 0, 1) / 2) ** 2 * np.exp(-np.maximum(0, u - 0.8) * 18)
    return lp(noise(d), 0.03 + bright * u ** 1.5) * e
def mclick(big=False):
    x = np.zeros(int(0.12 * SR))
    a = hp(noise(0.004)) * np.exp(-np.arange(int(0.004 * SR)) / 40) + sine(3200, 0.004, 0.0002, 0.0015)
    x[: len(a)] += a
    r = 0.4 * a; o = int(0.075 * SR); x[o:o + len(r)] += r
    if big: x[: int(0.06 * SR)] += 0.7 * sine(110, 0.06, 0.001, 0.02)
    return x

def soft_bell(f, d=0.9, dec=0.3):  # rounder than bell(): slower attack, almost no upper partials
    t = tt(d)
    return (np.sin(2 * np.pi * f * t) + 0.12 * np.sin(4 * np.pi * f * t)) * env_ad(t, 0.006, dec)
def thock(d=0.05, f=900):  # muted key/click body, no hiss
    t = tt(d)
    return lp(hp(noise(d)), 0.25) * np.exp(-t / 0.006) + 0.6 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.008)

# Kept deliberately sparse: the score carries the rhythm, SFX only mark what the viewer sees happen.
# (Dropped after review: clock ticks, word blips, row blips, odometer ticks, tile pops, chirps.)
for c in EV['cues']:
    t, k, v = c['t'], c['k'], c['v']
    if k == 'pop':      put(mx(soft_bell(660, 0.3, 0.07), 0.8 * sine(165, 0.25, 0.006, 0.07)), t, 0, 0.16)
    elif k == 'whoosh': put(whoosh(0.36 + 0.25 * v, 0.1 + 0.12 * v), t, 0, 0.06 + 0.12 * v)
    elif k == 'drop':   put(whoosh(0.5, 0.3), t - 0.02, 0, 0.2)
    elif k == 'whooshBig': put(whoosh(0.9, 0.22), t + 0.25, 0, 0.22)
    elif k == 'sweep':  put(lp(hp(noise(0.22)), 0.2) * np.sin(np.pi * np.clip(tt(0.22) / 0.22, 0, 1)), t + 0.08, -0.15, 0.06)
    elif k == 'key':    put(thock(0.04, 700 + 200 * rng.random()), t, 0.2 * (rng.random() - 0.5), 0.07 + 0.02 * rng.random())
    elif k == 'click':  put(thock(0.06, 1000), t, 0.1, 0.2)
    elif k == 'clickBig': put(mx(thock(0.06, 900), 0.5 * sine(180, 0.08, 0.003, 0.03)), t, 0.1, 0.24)
    elif k == 'check':  put(soft_bell(mtof(PENTA[v + 3]), 0.6, 0.18), t, -0.1 + 0.05 * v, 0.1)
    elif k == 'done':   put(mx(soft_bell(mtof(81), 1.0, 0.35), 0.7 * np.concatenate([np.zeros(int(0.09 * SR)), soft_bell(mtof(86), 1.0, 0.4)])), t, 0, 0.13)
    elif k == 'pop2':   put(soft_bell(700, 0.2, 0.05), t, 0, 0.1)
    elif k == 'toast':  put(mx(soft_bell(mtof(86), 1.2, 0.45), 0.5 * soft_bell(mtof(93), 1.2, 0.4)), t, 0, 0.13)
    elif k == 'toggle': put(mx(thock(0.06, 800), 0.6 * soft_bell(mtof(74), 0.3, 0.06)), t, 0.15, 0.18)
    elif k == 'tchk':   put(soft_bell(mtof(PENTA[v]), 0.4, 0.12), t, -0.5 + 0.09 * v, 0.05)
    elif k == 'swell':  # a soft reversed swell that breathes into the dark ending
        d = 1.0; u = tt(d) / d; put(lp(noise(d), 0.01 + 0.2 * u ** 2) * u ** 3, t, 0, 0.2)
    elif k == 'tap':    put(thock(0.06, 1000), t, 0.1, 0.2)
    elif k == 'tapBig': put(mx(thock(0.06, 900), 0.5 * sine(180, 0.08, 0.003, 0.03)), t, 0.1, 0.24)
    elif k == 'tab':    put(mx(thock(0.06, 800), 0.6 * soft_bell(mtof(74), 0.3, 0.06)), t, 0.15, 0.18)
    elif k == 'save':   put(mx(thock(0.06, 850), 0.8 * soft_bell(mtof(81), 0.6, 0.16)), t, 0.1, 0.17)
    elif k == 'drag':   put(lp(hp(noise(0.3)), 0.12) * np.sin(np.pi * np.clip(tt(0.3) / 0.3, 0, 1)) ** 2, t + 0.14, 0.1, 0.05 + 0.04 * v)
    elif k == 'step':   put(lp(hp(noise(0.22)), 0.2) * np.sin(np.pi * np.clip(tt(0.22) / 0.22, 0, 1)), t + 0.08, -0.15, 0.05)
    elif k == 'line':   put(whoosh(0.8, 0.12), t + 0.6, -0.2, 0.08)
    elif k == 'sheet':  put(whoosh(0.32, 0.22), t + 0.12, 0, 0.1)
    elif k == 'sheetDown': put(whoosh(0.24, 0.15), t + 0.06, 0, 0.07)
    elif k == 'bullet': put(soft_bell(mtof(PENTA[v + 2]), 0.4, 0.12), t, -0.5 + 0.13 * v, 0.07)
    elif k == 'pin':    put(soft_bell(mtof(PENTA[(v % 8) + 3]), 0.35, 0.08), t, -0.4 + 0.07 * v, 0.045)
    elif k == 'age':    put(soft_bell(mtof(PENTA[v % 10]), 0.3, 0.06), t, -0.45 + 0.1 * v, 0.04)
    elif k == 'select': put(mx(thock(0.05, 900), soft_bell(mtof(86), 0.6, 0.18)), t, 0, 0.13)
    elif k == 'card':   put(mx(soft_bell(520 + 40 * v, 0.3, 0.07), 0.8 * sine(150, 0.25, 0.006, 0.07)), t, -0.5 + 0.2 * v, 0.13)
    elif k == 'suck' and v == 0: put(whoosh(0.6, 0.2), t + 0.35, 0, 0.12)
    elif k == 'rise':   put(whoosh(0.7, 0.18), t + 0.45, 0, 0.1)
    elif k == 'tile':   put(soft_bell(mtof(PENTA[v + 3]), 0.4, 0.1), t, -0.3 + 0.12 * v, 0.08)
    elif k == 'stage':  put(soft_bell(mtof(PENTA[v + 4]), 0.6, 0.18), t, 0, 0.1)
    elif k == 'morph':  put(whoosh(0.5, 0.18), t + 0.3, 0, 0.11)
    elif k == 'morphBack': put(whoosh(0.4, 0.15), t + 0.25, 0, 0.08)
    elif k == 'name':   put(mx(soft_bell(660 + 110 * v, 0.3, 0.07), 0.8 * sine(165, 0.25, 0.006, 0.07)), t, -0.2 + 0.4 * v, 0.14)
    elif k == 'odo':    put(soft_bell(mtof(PENTA[v + 5]), 0.5, 0.14), t + 1.5, -0.3 + 0.3 * v, 0.1)
    elif k == 'end':    d = 1.0; u = tt(d) / d; put(lp(noise(d), 0.01 + 0.2 * u ** 2) * u ** 3, t, 0, 0.16)
    elif k == 'mark':
        x = sum(soft_bell(mtof(m), 2.0, 0.8) for m in (74, 81, 86)) * env_ad(tt(2.0), 0.3, 1.5)
        put(x, t + 0.3, 0, 0.09)
sfx = reverb(sfx, 1.4, 0.2)

# ───────────────────────── mix ─────────────────────────
mix = 0.5 * music[:, :N] + 0.5 * sfx[:, :N]
import sys
DRIVE = float(sys.argv[1]) if len(sys.argv) > 1 else 1.45
mix *= DRIVE / np.max(np.abs(mix))   # gentle tanh limiter: louder body, peaks held at 0.93
mix = 0.70 * np.tanh(mix) / np.tanh(DRIVE)
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open('mix.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('mix.wav', mix.shape[1] / SR, 's')
