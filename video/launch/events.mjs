// node events.mjs → events.json (the film's own cue list: one source of truth for the audio)
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
const b = await chromium.launch({ channel: 'chromium', args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('file://' + resolve('film.html'));
await p.waitForFunction(() => window.READY === true);
const M = await p.evaluate(() => ({ DUR: window.M.DUR, cues: window.M.cues }));
writeFileSync('events.json', JSON.stringify(M, null, 0));
console.log(M.cues.length, 'cues,', M.DUR, 's');
await b.close();
