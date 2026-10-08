# Procedural macOS-style wallpaper: swooping layered glass bands.
import sys, numpy as np
from PIL import Image, ImageFilter

W, H = 2880, 1800
mode = sys.argv[1]
out = sys.argv[2]
y, x = np.mgrid[0:H, 0:W].astype(np.float32)
u = x / W
v = y / H

def smooth(e0, e1, t):
    t = np.clip((t - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

if mode == "light":
    sky_top, sky_bot = np.array([206, 228, 252]), np.array([136, 186, 246])
    bands = [  # (base, amp, freq, phase, tilt, top colour, bottom colour)
        (0.30, 0.10, 1.1, 0.4, -0.38, [140, 206, 250], [56, 140, 226]),
        (0.46, 0.12, 0.9, 1.6, -0.30, [88, 156, 240], [28, 86, 200]),
        (0.60, 0.11, 1.3, 2.4, -0.26, [52, 120, 228], [18, 58, 168]),
        (0.75, 0.10, 1.0, 3.3, -0.20, [34, 96, 210], [10, 38, 128]),
        (0.90, 0.08, 1.2, 4.1, -0.14, [22, 70, 182], [8, 26, 96]),
    ]
    sheen = 0.55
else:
    sky_top, sky_bot = np.array([18, 28, 58]), np.array([10, 22, 60])
    bands = [
        (0.30, 0.10, 1.1, 0.4, -0.38, [40, 74, 150], [14, 30, 82]),
        (0.46, 0.12, 0.9, 1.6, -0.30, [34, 72, 168], [10, 24, 74]),
        (0.60, 0.11, 1.3, 2.4, -0.26, [28, 62, 160], [8, 18, 62]),
        (0.75, 0.10, 1.0, 3.3, -0.20, [22, 50, 140], [6, 14, 50]),
        (0.90, 0.08, 1.2, 4.1, -0.14, [16, 40, 120], [4, 10, 40]),
    ]
    sheen = 0.32

img = sky_top[None, None, :] * (1 - v[..., None]) + sky_bot[None, None, :] * v[..., None]
# Soft light bloom in the upper left of the sky.
bloom = np.exp(-(((u - 0.22) / 0.35) ** 2 + ((v - 0.05) / 0.30) ** 2))
img = img + (255 - img) * (bloom[..., None] * (0.45 if mode == "light" else 0.12))

curves = []
for base, amp, freq, ph, tilt, _, _ in bands:
    c = base + tilt * (u - 0.5) + amp * np.sin(freq * np.pi * 2 * u + ph) + amp * 0.35 * np.sin(2.3 * np.pi * 2 * u + ph * 1.7)
    curves.append(c)

for i, (base, amp, freq, ph, tilt, top, bot) in enumerate(bands):
    c = curves[i]
    nxt = curves[i + 1] if i + 1 < len(curves) else np.full_like(c, 1.4)
    depth = np.clip((v - c) / np.maximum(nxt - c, 0.05), 0, 1)  # 0 at this edge, 1 at the next
    col = np.array(top)[None, None, :] * (1 - depth[..., None] ** 0.7) + np.array(bot)[None, None, :] * depth[..., None] ** 0.7
    # Lit along the top edge, like a folded sheet of glass.
    lit = np.exp(-((v - c) / 0.012) ** 2) * (v > c - 0.03)
    col = col + (255 - col) * (lit[..., None] * sheen)
    # Shadow cast on the band above, just over the edge.
    shade = np.exp(-((c - v) / 0.05) ** 2) * (v < c)
    tint = np.array([0.70, 0.80, 0.98])[None, None, :]
    img = img * (1 - shade[..., None] * 0.30 * (1 - tint))
    a = smooth(-0.0015, 0.0015, v - c)[..., None]
    img = img * (1 - a) + col * a

im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
im = im.filter(ImageFilter.GaussianBlur(1.2))
arr = np.asarray(im).astype(np.float32)
arr += np.random.default_rng(7).normal(0, 1.6, arr.shape)  # grain against banding
Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(out, quality=86, method=6)
print(out)
