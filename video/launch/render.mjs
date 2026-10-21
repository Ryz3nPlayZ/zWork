// node render.mjs <out.mp4> [--scale 1] [--fps 60] [--sub 4] [--workers 8] [--from 0] [--to DUR] [--draft]
// Each worker owns a contiguous run of frames, screenshots every subframe, and pipes the images
// straight into its own ffmpeg (no frames on disk). tmix averages the subframes into motion blur
// (360° shutter, centred on the frame time). Chunks are concatenated without re-encoding, then the
// score is muxed in.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';

const FF = '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const out = resolve(argv[0] || 'deliver/zwork-intro.mp4');
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : +argv[i + 1]; };
const draft = argv.includes('--draft');
const scale = opt('scale', 1), fps = opt('fps', 60), sub = opt('sub', 4), W = opt('workers', 8);
const DUR = 37.0, from = opt('from', 0), to = opt('to', DUR);
const F0 = Math.round(from * fps), F1 = Math.round(to * fps);
const tmp = resolve('chunks'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
mkdirSync(resolve(out, '..'), { recursive: true });

const subT = (f, j) => Math.max(0, f / fps + (j - (sub - 1) / 2) / (fps * sub));
const vf = (sub > 1 ? [`tmix=frames=${sub}:weights='${Array(sub).fill(1).join(' ')}'`, `select='eq(mod(n\\,${sub})\\,${sub - 1})'`, `setpts=N/(${fps}*TB)`] : [])
  .concat(['scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p']).join(',');
const enc = draft ? ['-preset', 'veryfast', '-crf', '23'] : ['-preset', 'slow', '-crf', '15', '-tune', 'film'];

function ffmpeg(path) {
  const p = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps * sub),
    '-c:v', draft ? 'mjpeg' : 'png', '-i', '-', '-vf', vf, '-r', String(fps), '-c:v', 'libx264', ...enc,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', path], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, no) => p.on('close', c => c ? no(new Error('ffmpeg ' + c)) : ok()));
  return { p, done };
}
const write = (s, buf) => new Promise(ok => s.write(buf) ? ok() : s.once('drain', ok));

const browser = await chromium.launch({ channel: 'chromium', args: ['--allow-file-access-from-files', '--force-color-profile=srgb'] });
const per = Math.ceil((F1 - F0) / W), chunks = [], t0 = Date.now();
let shot = 0; const total = (F1 - F0) * sub;
const tick = setInterval(() => process.stdout.write(`\r${shot}/${total} subframes  ${((Date.now() - t0) / 1000).toFixed(0)} s`), 2000);

await Promise.all(Array.from({ length: W }, async (_, w) => {
  const a = F0 + w * per, b = Math.min(F1, a + per);
  if (a >= b) return;
  const path = `${tmp}/c${String(w).padStart(2, '0')}.mp4`; chunks[w] = path;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
  page.on('pageerror', e => console.error('\npage error:', String(e)));
  await page.goto('file://' + resolve('film.html'));
  await page.waitForFunction(() => window.READY === true, null, { timeout: 30000 });
  const ff = ffmpeg(path);
  for (let f = a; f < b; f++) for (let j = 0; j < sub; j++) {
    await page.evaluate(t => window.seek(t), subT(f, j));
    await write(ff.p.stdin, await page.screenshot(draft ? { type: 'jpeg', quality: 88 } : { type: 'png' }));
    shot++;
  }
  ff.p.stdin.end(); await ff.done; await page.close();
}));
clearInterval(tick); await browser.close();

const list = `${tmp}/list.txt`;
writeFileSync(list, chunks.filter(Boolean).map(c => `file '${c}'`).join('\n'));
const run = args => new Promise((ok, no) => spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }).on('close', c => c ? no(new Error('ffmpeg ' + c)) : ok()));
await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', `${tmp}/video.mp4`]);
const audio = existsSync('mix.wav') && !argv.includes('--mute');
await run(audio
  ? ['-i', `${tmp}/video.mp4`, '-ss', String(from), '-t', String(to - from), '-i', 'mix.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', out]
  : ['-i', `${tmp}/video.mp4`, '-c', 'copy', out]);
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${out}  ${(F1 - F0)} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
