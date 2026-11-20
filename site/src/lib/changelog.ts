import raw from "../../../CHANGELOG.md?raw";

/**
 * The repository's CHANGELOG.md, read at build time and shaped for the
 * changelog page. Only the subset of markdown the file uses is understood:
 * `## version`, `### section`, `- item` (with indented follow-on lines), plain
 * paragraphs and `> notes`; inline bold, code and links are left in the text
 * for the page to render.
 */

export type ChangeSection = { title: string; items: string[] };
export type Release = { version: string; intro: string[]; sections: ChangeSection[] };

/** Entries before 0.6 were written for developers; the page links to them on GitHub instead. */
const FIRST_SHOWN: [number, number] = [0, 6];
/** Sections about the build itself, not about what changed for people using zWork. */
const HIDDEN_SECTIONS = /^(infrastructure|internal|dev|build)/i;

function parse(md: string): Release[] {
  const releases: Release[] = [];
  let rel: Release | null = null;
  let sec: ChangeSection | null = null;
  let lastItem = false;
  for (const line of md.split("\n")) {
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      rel = { version: h2[1].trim().replace(/^v/, ""), intro: [], sections: [] };
      releases.push(rel);
      sec = null;
      lastItem = false;
      continue;
    }
    if (!rel) continue;
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      sec = { title: h3[1].trim(), items: [] };
      rel.sections.push(sec);
      lastItem = false;
      continue;
    }
    const item = line.match(/^[-*] (.+)/);
    if (item && sec) {
      sec.items.push(item[1].trim());
      lastItem = true;
      continue;
    }
    if (!line.trim()) continue;
    if (/^\s+\S/.test(line) && lastItem && sec) {
      sec.items[sec.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    const text = line.replace(/^>\s?/, "").trim();
    if (sec) sec.items.push(text);
    else rel.intro.push(text);
    lastItem = false;
  }
  return releases;
}

function shown(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false; // pre-releases and "Unreleased"
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > FIRST_SHOWN[0] || (maj === FIRST_SHOWN[0] && min >= FIRST_SHOWN[1]);
}

export const RELEASES: Release[] = parse(raw)
  .filter((r) => shown(r.version))
  .map((r) => ({ ...r, sections: r.sections.filter((s) => !HIDDEN_SECTIONS.test(s.title) && s.items.length) }));
