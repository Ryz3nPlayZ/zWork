// node capture.mjs → app/*.html DOM snapshots + app/*.png reference shots of the real app
// Drives the live local app (python3 -m http.server 4321) through the film's flow with the clock
// frozen, so every screen in the film is the app's own markup, not a redraw.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const URL = process.env.APP || 'http://localhost:4321/';
const OUT = 'app';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: 'chromium' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
// The clock starts at a fixed after-school moment and then runs, so Leaflet's animations can finish
await p.clock.install({ time: new Date('2026-10-28T15:40:00') });
await p.clock.resume();
p.on('response', (r) => { if (r.url().includes('tile.openstreetmap') && r.status() !== 200) console.log('tile', r.status()); });
p.on('requestfailed', (r) => console.log('FAIL', r.url().slice(0, 80), r.failure()?.errorText));
p.on('pageerror', (e) => console.log('page error', String(e)));
await p.goto(URL);
// Leaflet fades tiles in by wall-clock time, which is frozen here
await p.addStyleTag({ content: '.leaflet-tile { opacity: 1 !important }' }).catch(() => {});
await p.evaluate(() => localStorage.clear());
await p.reload();
await p.addStyleTag({ content: '.leaflet-tile { opacity: 1 !important }' });
await p.waitForTimeout(800);

// freeze form state into attributes so outerHTML carries it
const freeze = () => p.evaluate(() => {
  document.querySelectorAll('select').forEach((s) => [...s.options].forEach((o) => o.toggleAttribute('selected', o.selected)));
  document.querySelectorAll('input').forEach((i) => i.setAttribute('value', i.value));
});
const snap = async (name, sel = 'body') => {
  await freeze();
  const html = await p.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.outerHTML : '';
  }, sel);
  writeFileSync(`${OUT}/${name}.html`, html);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log('snap', name, html.length);
};

// onboarding
await snap('ob-welcome', '#onboard');
await p.click('[data-ob="next"]'); await p.waitForTimeout(200);
await snap('ob-age0', '#onboard');
await p.click('[data-ob-age="15"]'); await snap('ob-age1', '#onboard');
await p.click('[data-ob="next"]'); await p.waitForTimeout(200);
await snap('ob-hood0', '#onboard');
await p.click('[data-ob-hood="Corona"]'); await snap('ob-hood1', '#onboard');
await p.click('[data-ob="next"]'); await p.waitForTimeout(200);
await snap('ob-into0', '#onboard');
await p.click('[data-ob-into="tutoring"]'); await p.click('[data-ob-into="music"]'); await p.click('[data-ob-into="explore"]');
await snap('ob-into1', '#onboard');
await p.click('[data-ob="next"]'); await p.waitForTimeout(600);

// home
await snap('home', '.app');
await p.screenshot({ path: `${OUT}/home-full.png`, fullPage: true });
const stops = await p.$$eval('#stops [data-stop]', (s) => s.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
console.log('stops', stops);

// explore
await p.click('.tabbar [data-tab="explore"]'); await p.waitForTimeout(300);
await snap('explore0', '.app');
await p.click('#right-now'); await p.waitForTimeout(500);
await p.evaluate(() => window.scrollTo(0, 0));
await snap('explore-now', '.app');
await p.screenshot({ path: `${OUT}/explore-now-full.png`, fullPage: true });
console.log('now results', await p.$$eval('#list .card__name', (s) => s.map((x) => x.textContent)));
console.log('count', await p.$eval('#count', (e) => e.textContent));

// map
await p.click('.viewtoggle [data-view="map"]'); await p.waitForTimeout(2500);
await p.evaluate(() => window.scrollTo(0, 0));
console.log('map state', await p.evaluate(() => { map.invalidateSize(); drawMap(lastResults); return [map.getZoom(), map.getSize(), map.getCenter()]; }));
await p.waitForTimeout(2500);
console.log('map state', await p.evaluate(() => [map.getZoom(), map.getSize()]));
await snap('explore-map', '.app');
const mapBox = await p.$eval('#map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height }; });
const pins = await p.$$eval('#map .leaflet-marker-icon', (ms) => ms.map((m) => { const r = m.getBoundingClientRect(), mr = document.querySelector('#map').getBoundingClientRect(); return { x: r.x - mr.x + r.width / 2, y: r.y - mr.y + r.height / 2, w: r.width, h: r.height, html: m.outerHTML }; }));
await p.addStyleTag({ content: '#map .leaflet-marker-pane, #map .leaflet-popup-pane, #map .leaflet-control-zoom, .tabbar, .appbar { visibility: hidden }' });
await p.waitForTimeout(1500);
await (await p.$('#map')).screenshot({ path: `${OUT}/map-tiles.png` });
await p.addStyleTag({ content: '#map .leaflet-marker-pane, .tabbar, .appbar { visibility: visible !important }' });
writeFileSync(`${OUT}/map.json`, JSON.stringify({ mapBox, pins }, null, 1));
console.log('pins', pins.length);


// details sheet: the closest study space, then a museum that meets on a schedule
const sheet = async (name) => {
  await snap(name, '#details');
  const sh = await p.$eval('#details', (d) => ({ scrollH: d.scrollHeight, h: d.clientHeight, top: d.getBoundingClientRect().top }));
  console.log(name, sh);
  const mm = await p.$('#minimap');
  if (mm) { await p.waitForTimeout(1500); await mm.screenshot({ path: `${OUT}/${name}-minimap.png` }); }
};
await p.click('.viewtoggle [data-view="list"]'); await p.waitForTimeout(300);
await p.click('#list [data-open="cor-library"]'); await p.waitForTimeout(600);
await sheet('d-cor');
await p.click('#details [data-save="cor-library"]'); await p.waitForTimeout(200);
await sheet('d-cor-saved');
await p.click('#d-invite'); await p.waitForTimeout(300);
await snap('toast-invite', '#toast');
await p.click('#d-close'); await p.waitForTimeout(600);
await p.click('#list [data-open="queens-museum"]'); await p.waitForTimeout(600);
await sheet('d-qm');
await p.click('#details [data-save="queens-museum"]'); await p.waitForTimeout(200);
await p.click('#d-cal'); await p.waitForTimeout(400);
await snap('toast-cal', '#toast');
await sheet('d-qm-cal');
await p.click('#d-close'); await p.waitForTimeout(600);
await snap('explore-after', '.app');

// saved
await p.click('.tabbar [data-tab="saved"]'); await p.waitForTimeout(400);
await snap('saved', '.app');
await p.click('#share-saved'); await p.waitForTimeout(300);
await snap('toast-share', '#toast');
console.log('clipboard', await p.evaluate(() => navigator.clipboard.readText()));

// you
await p.click('.tabbar [data-tab="you"]'); await p.waitForTimeout(300);
await snap('you', '.app');
await b.close();
