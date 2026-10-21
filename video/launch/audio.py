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

def section_gain(t):
    # pad level & brightness by section
    if t < 4: return 0.55, 2.2
    if t < 8: return 0.6, 2.6
    if t < 14: return 0.55 + 0.25 * (t - 8) / 6, 2.6 + 3.5 * (t - 8) / 6
    if t < 24: return 0.75, 5.0
    if t < 28: return 0.6, 3.2
    return 0.8, 5.5

for b in range(16):  # bars 0..15 (0–32 s)
    t0 = b * 2.0
    g, br = section_gain(t0 + 0.01)
    d = 2.0 if t0 + 2 <= 31.5 else 31.5 - t0
    L, R = pad_bar(CHORDS[b % 4], d, br, rel=0.5 if t0 + 2 <= 31.5 else 0.05)
    add(music, L, t0, -0.35, 0.05 * g); add(music, R, t0, 0.35, 0.05 * g)
# ending chord: Dm(add9) slam, rings out
L, R = pad_bar([38, 50, 53, 57, 64, 69], 3.6, 4.5, rel=1.6, att=0.004)
add(music, L, 32.0, -0.3, 0.06); add(music, R, 32.0, 0.3, 0.06)

# arp (8ths) with ping-pong dotted-8th delay
def pluck(f, d=0.5, dec=0.16):
    t = tt(d); e = env_ad(t, 0.003, dec)
    return (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)) * e
PAT = [0, 1, 2, 3, 2, 1, 3, 1]
arpL = np.zeros(N + SR * 3); arpR = np.zeros(N + SR * 3)
for k in range(int(31.5 / 0.25)):
    t0 = k * 0.25
    if 13.75 <= t0 < 14.0: continue
    ch = CHORDS[bar_of(t0) % 4]; notes = [m + 12 for m in ch] + [ch[0] + 24]
    m = notes[PAT[k % 8]] + (12 if t0 >= 28 else 0)
    vel = 0.55 + 0.45 * ((k % 2) == 0)
    sec = 0.6 if t0 < 8 else 0.85 if t0 < 14 else 1.0 if t0 < 24 else 0.7 if t0 < 28 else 1.0
    x = pluck(mtof(m)) * vel * sec
    i = int(t0 * SR); arpL[i:i + len(x)] += x; arpR[i:i + len(x)] += x
dl = int(0.375 * SR)
eL, eR = np.zeros_like(arpL), np.zeros_like(arpR)
eL[dl:] += 0.32 * arpR[:-dl]; eR[2 * dl:] += 0.22 * arpL[:-2 * dl]
music[0] += 0.075 * (arpL + eL); music[1] += 0.075 * (arpR + eR)

# drums
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

for k in range(int(31.5 / 0.125)):
    t0 = k * 0.125; beat = (k % 4 == 0); eighth = (k % 2 == 0)
    if 13.75 <= t0 < 14.0: continue
    b = bar_of(t0); root = ROOTS[b % 4]
    if 4 <= t0 < 8:
        if k % 8 == 0: add(music, kick(0.55), t0)
        if k % 4 == 2: add(music, hat(0.10), t0, 0.3)
    elif 8 <= t0 < 14:
        add(music, hat(0.05 + 0.07 * (t0 - 8) / 6), t0, 0.35 if k % 2 else -0.2)
    elif 14 <= t0 < 24 or 28 <= t0 < 31.5:
        if beat: add(music, kick(0.9), t0)
        if beat and (k // 4) % 2 == 1: add(music, clap(0.32), t0, 0.05)
        if k % 4 == 2: add(music, hat(0.14, open_=True), t0, 0.25)
        elif not beat: add(music, hat(0.07), t0, -0.25)
        if k % 2 == 0 and not beat: add(music, bass(mtof(root), 0.3, 0.26), t0)
        if beat: add(music, bass(mtof(root - 12) * 2, 0.22, 0.12), t0)
    elif 24 <= t0 < 28:
        if k % 16 == 0: add(music, kick(0.75), t0)
        if k % 16 == 10: add(music, kick(0.45), t0)
        if eighth and not beat: add(music, hat(0.08), t0, 0.2)
        if k % 8 == 0: add(music, bass(mtof(root), 0.9, 0.22), t0)

# build: accelerating snare roll + riser, then a clean gap before the drop
roll = list(np.arange(8, 10, 0.5)) + list(np.arange(10, 12, 0.25)) + list(np.arange(12, 13, 0.125)) + list(np.arange(13, 13.75, 0.0625))
for t0 in roll:
    add(music, snare(0.12 + 0.38 * ((t0 - 8) / 5.75) ** 1.6), t0, 0.08)
d = 3.75; t = tt(d); u = t / d
rz = lp(noise(d), 0.02 + 0.5 * u ** 2.2) * (u ** 2.4) * 2.2
rz += 0.25 * np.sin(2 * np.pi * np.cumsum(220 + 700 * u ** 2) / SR) * u ** 3
add(music, rz, 10.0, 0, 0.5)

# drop & slam booms
def boom(d=1.4, f0=55):
    t = tt(d); f = f0 + 60 * np.exp(-t / 0.05)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ad(t, 0.002, d / 3.5)
add(music, boom(1.2, 49), 14.0, 0, 0.55)
add(music, kick(1.0), 32.0); add(music, boom(2.2, 36.7), 32.0, 0, 0.8)

# section mute: one beat of silence before the slam, and fade at the end
tm = np.arange(music.shape[1]) / SR
gate = np.ones_like(tm)
gate[(tm >= 31.5) & (tm < 32.0)] = 0
gate *= np.clip((37.0 - tm) / 0.9, 0, 1)
gate[(tm >= 13.75) & (tm < 14.0)] *= 0.12
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
music *= np.vstack([np.where(tm < 37.0, 1, 0)] * 2)

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

for c in EV['cues']:
    t, k, v = c['t'], c['k'], c['v']
    if k == 'pop':      put(sine(880, 0.12, 0.001, 0.04) * 0.6 + sine(140, 0.18, 0.002, 0.06), t, 0, 0.45)
    elif k == 'tick':   put(sine(2600, 0.02, 0.0005, 0.004) + 0.7 * sine(1300, 0.04, 0.0005, 0.012), t, 0.2, 0.22)
    elif k == 'word':   put(sine(620, 0.08, 0.001, 0.03) + 0.3 * hp(noise(0.02)) * np.exp(-np.arange(int(0.02 * SR)) / 150), t, -0.1, 0.26)
    elif k == 'whoosh': put(whoosh(0.32 + 0.25 * v, 0.18 + 0.2 * v), t, 0, 0.12 + 0.22 * v)
    elif k == 'drop':   put(whoosh(0.5, 0.45), t - 0.02, 0, 0.35)
    elif k == 'whooshBig': put(whoosh(0.9, 0.35), t + 0.25, 0, 0.42)
    elif k == 'row':    put(sine(1500 + 120 * (t * 8 % 7), 0.05, 0.0005, 0.012), t, 0.15, 0.13)
    elif k == 'sweep':  put(lp(hp(noise(0.22)), 0.35) * np.sin(np.pi * np.clip(tt(0.22) / 0.22, 0, 1)), t + 0.08, -0.15, 0.2)
    elif k == 'key':
        x = hp(noise(0.012), 2) * np.exp(-np.arange(int(0.012 * SR)) / (90 + 40 * rng.random()))
        x = np.concatenate([x, np.zeros(400)]); x[:600] += 0.5 * sine(170 + 60 * rng.random(), 0.0125, 0.0005, 0.004)[:600]
        put(x, t, 0.25 * (rng.random() - 0.5), 0.2 + 0.06 * rng.random())
    elif k == 'click':  put(mclick(), t, 0.1, 0.42)
    elif k == 'clickBig': put(mclick(True), t, 0.1, 0.5)
    elif k == 'tick2':  put(sine(1250, 0.05, 0.001, 0.015), t, 0.1, 0.09)
    elif k == 'check':  put(bell(mtof(PENTA[v + 3]), 0.8, 0.3), t, -0.1 + 0.05 * v, 0.26)
    elif k == 'done':   put(bell(mtof(81), 1.0, 0.4) + 0.8 * np.concatenate([np.zeros(int(0.09 * SR)), bell(mtof(86), 1.0, 0.45)])[: int(SR * 1.0)], t, 0, 0.3)
    elif k == 'odo':    put(sine(3600, 0.006, 0.0003, 0.0015), t, 0.3, 0.06)
    elif k == 'pop2':   put(sine(700, 0.1, 0.001, 0.035) + 0.4 * sine(1400, 0.06, 0.001, 0.02), t, 0, 0.25)
    elif k == 'born':   x = tt(0.12); put(np.sin(2 * np.pi * np.cumsum(500 + 600 * x / 0.12) / SR) * env_ad(x, 0.004, 0.05), t, 0.2, 0.2)
    elif k == 'row2':   put(sine(1700 + 90 * v, 0.04, 0.0005, 0.01), t, 0.2, 0.1)
    elif k == 'bar':    put(sine(mtof(PENTA[v + 2]), 0.25, 0.01, 0.08), t, 0.3, 0.1)
    elif k == 'toast':  put(bell(mtof(86), 1.2, 0.5) + 0.6 * bell(mtof(93), 1.2, 0.45), t, 0, 0.3)
    elif k == 'toggle':
        x = np.concatenate([sine(660, 0.05, 0.001, 0.02), sine(990, 0.08, 0.001, 0.03)]); put(x, t, 0.15, 0.28)
    elif k == 'tpop':   put(sine(900 + 40 * v, 0.05, 0.0008, 0.015), t, -0.4 + 0.08 * v, 0.1)
    elif k == 'tchk':   put(bell(mtof(PENTA[v]), 0.5, 0.18), t, -0.5 + 0.09 * v, 0.16)
    elif k == 'slam0':  put(hp(noise(0.25)) * np.exp(-tt(0.25) / 0.05), t, 0, 0.35)
    elif k == 'slam':
        f = mtof([50, 53, 55, 57, 60, 62][v])
        x = boom(0.6, f / 2) * 0.9 + 0.5 * bell(f * 2, 0.6, 0.18) + 0.3 * hp(noise(0.6)) * np.exp(-tt(0.6) / 0.015)
        put(x, t, -0.3 + 0.12 * v, 0.62)
    elif k == 'mark':
        x = sum(bell(mtof(m), 2.0, 0.8) for m in (74, 81, 86)) * env_ad(tt(2.0), 0.25, 1.5)
        put(x, t + 0.25, 0, 0.13)

# ───────────────────────── mix ─────────────────────────
mix = 0.5 * music[:, :N] + 0.62 * sfx[:, :N]
mix *= 0.93 / np.max(np.abs(mix))
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open('mix.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('mix.wav', mix.shape[1] / SR, 's')
