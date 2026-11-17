// node snap.mjs <outdir> <scale> t1 t2 …   → PNG stills of film.html at the given times
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
const [out, scale, ...ts] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--allow-file-access-from-files', '--force-color-profile=srgb'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: +scale || 1 });
const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto('file://' + resolve('film.html'));
await page.waitForFunction(() => window.READY === true, null, { timeout: 20000 });
let i = 0;
for (const t of ts) {
  await page.evaluate(t => window.seek(t), +t);
  await page.screenshot({ path: `${out}/${String(i++).padStart(3, '0')}_${(+t).toFixed(2)}.png` });
}
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await browser.close();
