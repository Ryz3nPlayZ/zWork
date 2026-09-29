# zWork landing page

The marketing site for tryzwork.app. Vite + React 19 + Tailwind v4 + Motion, static output.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

## Screenshots

`public/shots/{hero,report,steps}-{light,dark}.webp` are real captures of the app at 1440x900 @2x,
taken from one run of the Q3 expenses demo. The numbers in `src/components/Proof.tsx` come from that
same run; retake both together. `public/og.png` (1200x630) is the social card.

## Deploy

Any static host works. On Vercel: import the repo, set the root directory to `landing`, framework
preset Vite, build `npm run build`, output `dist`. Point `tryzwork.app` at the project.

Links (download, privacy, terms) live in `src/lib/site.ts`.
