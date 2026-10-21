# python3 sheet.py <dir> <out.png> <cols> <thumb_w>  → contact sheet, captioned with the time in each filename
import sys, os
from PIL import Image, ImageDraw
d, out, cols, tw = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
fs = sorted(f for f in os.listdir(d) if f.endswith('.png'))
ims = [Image.open(os.path.join(d, f)).convert('RGB') for f in fs]
th = round(tw * ims[0].height / ims[0].width)
rows = (len(ims) + cols - 1) // cols
S = Image.new('RGB', (cols * (tw + 6) + 6, rows * (th + 26) + 6), (40, 40, 40))
dr = ImageDraw.Draw(S)
for k, (f, im) in enumerate(zip(fs, ims)):
    x, y = 6 + (k % cols) * (tw + 6), 6 + (k // cols) * (th + 26)
    S.paste(im.resize((tw, th), Image.LANCZOS), (x, y))
    dr.text((x + 4, y + th + 5), f.split('_')[1][:-4] + 's', fill=(230, 230, 230))
S.save(out)
