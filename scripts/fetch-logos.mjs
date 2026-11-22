// Downloads brand logos from logo.dev into app/public/logos so the app ships them offline.
// Run every few months: node scripts/fetch-logos.mjs   (uses the publishable key only)
import { writeFile } from "node:fs/promises";

const TOKEN = process.env.LOGO_DEV_PK || "pk_U1FE6_rDR4q_PKm6GEBI7Q";
// app id (as used by AppBrandLogo) -> company domain.
// shortcut: logo.dev is company-level (gmail.com gives the Google "G", outlook.com the Microsoft squares),
// so Google/Microsoft products keep their Simple Icons marks in BrandLogos.tsx.
export const DOMAINS = {
  notion: "notion.so", github: "github.com", linear: "linear.app",
  quickbooks: "quickbooks.intuit.com", xero: "xero.com", slack: "slack.com",
};

for (const [id, domain] of Object.entries(DOMAINS)) {
  const res = await fetch(`https://img.logo.dev/${domain}?token=${TOKEN}&size=128&format=png&retina=true`);
  if (!res.ok) { console.error(`${id}: HTTP ${res.status}`); process.exitCode = 1; continue; }
  await writeFile(new URL(`../app/public/logos/${id}.png`, import.meta.url), Buffer.from(await res.arrayBuffer()));
  console.log(`${id} <- ${domain}`);
}
