# zWork banner assets

Brand-accurate lockups of the zWork logo mark + wordmark + tagline
**"Bringing the agentic era to non-devs"**. Built by hand as SVG (the asset is
the existing logo + type) and rasterized to PNG. Light + dark variants to match
the app's dual theme.

## Files

| File | Size | Use |
|------|------|-----|
| `banner-og-light.svg` / `.png` | 1200×630 | Open Graph / Twitter card (primary, light) |
| `banner-og-dark.svg` / `.png` | 1200×630 | OG / Twitter card (dark) |
| `banner-wide-light.svg` | 1500×500 | Wide header / cover (light) |
| `banner-wide-dark.svg` | 1500×500 | Wide header / cover (dark) |

## Palette

- Light: paper `#F2F0E8` bg, ink `#302E28` type, muted ink `#6E6A60` tagline.
- Dark: ink `#2A2A2E` bg, paper `#DCDAD2` type, muted `#8C8A82` tagline.

Type: Inter (semibold wordmark, regular tagline). Logo: the angular "z" from
[`app/public/zwork.svg`](../../app/public/zwork.svg).

## Regenerate PNGs

SVGs are the source of truth. To re-rasterize (e.g. after editing an SVG):

```bash
# Requires sharp: npm install sharp in a scratch dir, then:
node rasterize.mjs   # writes the .png files next to the .svg files
```
