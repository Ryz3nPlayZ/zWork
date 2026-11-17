// node bundle.mjs → app/bundle.js: the real app's stylesheet, fonts and DOM snapshots packed into one
// script so film.html can build every phone screen from srcdoc iframes over file://
import { readFileSync, writeFileSync } from 'fs';
const SRC = process.env.SRC || '/Users/zemuliu/Library/Application Support/Claude/scratch-workspaces/497391c4-1b26-4dd1-a89f-8f4243c49fa2/ae1c10ee-fc9f-4cce-94e1-f987d983439b/scratch-2026-10-25-10663b';
const names = ['ob-welcome', 'ob-age0', 'ob-hood0', 'ob-into0', 'home', 'explore-now', 'explore-map', 'd-cor', 'd-qm', 'saved'];
const snaps = Object.fromEntries(names.map(n => [n, readFileSync(`app/${n}.html`, 'utf8')]));
const APP = { css: readFileSync(`${SRC}/styles.css`, 'utf8'), fonts: readFileSync('fonts/fonts.css', 'utf8'), snaps, map: JSON.parse(readFileSync('app/map.json', 'utf8')) };
writeFileSync('app/bundle.js', 'window.APP=' + JSON.stringify(APP) + ';\n');
console.log('app/bundle.js', Object.keys(snaps).length, 'snaps');
