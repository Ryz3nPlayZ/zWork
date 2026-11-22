// Bundles full-colour app logos into app/public/logos + app/src/lib/logos.json so the app shows them offline.
// Run every few months:  node scripts/fetch-logos.mjs
// Order per app: svgl.app (exact product marks, e.g. Gmail not Google) -> gilbarbara/logos -> logo.dev (company marks, publishable key only).
// Apps not listed here fall back at runtime to the logo Composio sends with each connector.
import { mkdir, rm, writeFile } from "node:fs/promises";

const LOGO_DEV_PK = process.env.LOGO_DEV_PK || "pk_U1FE6_rDR4q_PKm6GEBI7Q";
// Composio toolkit slug -> [svgl search title, company domain, gilbarbara/logos name (CC0) when svgl lacks it].
// Left out on purpose: apps whose domain only gives the parent company's mark (Google Docs -> the Google "G"),
// or only a tiny or wordmark logo (QuickBooks -> Intuit, DocuSign, Evernote, Zoho).
const APPS = {
  gmail: ["Gmail", "gmail.com"], outlook: ["Microsoft Outlook", "outlook.com"],
  googlecalendar: ["Google Calendar", "calendar.google.com"], googledrive: ["Google Drive", "drive.google.com"],
  googlesheets: ["Google Sheets", "sheets.google.com"],
  googleslides: ["Google Slides", "slides.google.com"], googlemeet: ["Google Meet", "meet.google.com"],
  one_drive: ["Microsoft OneDrive", "onedrive.com"], excel: ["Microsoft Excel", "office.com"],
  microsoft_teams: ["Microsoft Teams", "teams.microsoft.com"], share_point: ["Microsoft SharePoint", "sharepoint.com"],
  slack: ["Slack", "slack.com"], notion: ["Notion", "notion.so"], xero: ["Xero", "xero.com"], github: ["GitHub", "github.com"], gitlab: ["GitLab", "gitlab.com"], linear: ["Linear", "linear.app"],
  trello: ["Trello", "trello.com"], asana: ["Asana", "asana.com"], jira: ["Jira", "atlassian.com", "jira"],
  confluence: ["Confluence", "atlassian.com", "confluence"], clickup: ["ClickUp", "clickup.com"], monday: ["Monday", "monday.com", "monday-icon"],
  airtable: ["Airtable", "airtable.com", "airtable"], todoist: ["Todoist", "todoist.com"], dropbox: ["Dropbox", "dropbox.com"],
  box: ["Box", "box.com"], zoom: ["Zoom", "zoom.us"], discord: ["Discord", "discord.com"], whatsapp: ["WhatsApp", "whatsapp.com"],
  hubspot: ["HubSpot", "hubspot.com"], salesforce: ["Salesforce", "salesforce.com"], pipedrive: ["Pipedrive", "pipedrive.com"],
  zendesk: ["Zendesk", "zendesk.com"], intercom: ["Intercom", "intercom.com"], stripe: ["Stripe", "stripe.com"],
  shopify: ["Shopify", "shopify.com"], mailchimp: ["Mailchimp", "mailchimp.com"], calendly: ["Calendly", "calendly.com"],
  typeform: ["Typeform", "typeform.com"], figma: ["Figma", "figma.com"],
  canva: ["Canva", "canva.com"], linkedin: ["LinkedIn", "linkedin.com"], twitter: ["X", "x.com"], youtube: ["YouTube", "youtube.com"],
  instagram: ["Instagram", "instagram.com"], facebook: ["Facebook", "facebook.com"], reddit: ["Reddit", "reddit.com"],
  wordpress: ["WordPress", "wordpress.com"], webflow: ["Webflow", "webflow.com"], freshbooks: ["FreshBooks", "freshbooks.com"],
 spotify: ["Spotify", "spotify.com"],
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
async function fromSvgl(title) {
  const res = await fetch(`https://api.svgl.app?search=${encodeURIComponent(title)}`);
  if (!res.ok) return null;
  const list = await res.json().catch(() => null);
  if (!Array.isArray(list)) return null;
  const hit = list.find((x) => norm(x.title) === norm(title));
  if (!hit) return null;
  const route = typeof hit.route === "string" ? hit.route : hit.route.light; // light mark: tiles are white
  const svg = await fetch(route);
  return svg.ok ? { ext: "svg", body: Buffer.from(await svg.arrayBuffer()) } : null;
}
async function fromGilbarbara(name) {
  if (!name) return null;
  const res = await fetch(`https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/${name}.svg`);
  return res.ok ? { ext: "svg", body: Buffer.from(await res.arrayBuffer()) } : null;
}
async function fromLogoDev(domain) {
  const res = await fetch(`https://img.logo.dev/${domain}?token=${LOGO_DEV_PK}&size=128&format=png&retina=true&fallback=404`);
  return res.ok ? { ext: "png", body: Buffer.from(await res.arrayBuffer()) } : null;
}

const dir = new URL("../app/public/logos/", import.meta.url);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const manifest = {};
for (const [id, [title, domain, gil]] of Object.entries(APPS)) {
  const logo = (await fromSvgl(title)) ?? (await fromGilbarbara(gil)) ?? (await fromLogoDev(domain));
  if (!logo) { console.warn(`${id}: no logo, Composio's will be used`); continue; }
  const file = `${id}.${logo.ext}`;
  await writeFile(new URL(file, dir), logo.body);
  manifest[id] = file;
  console.log(`${id.padEnd(16)} ${logo.ext === "png" ? "logo.dev" : "svg"}`);
}
await writeFile(new URL("../app/src/lib/logos.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${Object.keys(manifest).length}/${Object.keys(APPS).length} bundled`);
