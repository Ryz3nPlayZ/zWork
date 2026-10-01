import {
  siAirtable, siAsana, siCalendly, siClickup, siDiscord, siDropbox, siFigma, siGithub, siGmail, siGooglecalendar,
  siGoogledocs, siGoogledrive, siGooglemeet, siGooglesheets, siGoogleslides, siHubspot, siIntercom, siJira, siLinear,
  siMailchimp, siMiro, siNotion, siQuickbooks, siShopify, siStripe, siTodoist, siTrello, siTypeform, siWhatsapp,
  siXero, siYoutube, siZendesk, siZoom, type SimpleIcon,
} from "simple-icons";
import { Reveal, Section } from "./ui";

const APPS: SimpleIcon[] = [
  siGmail, siGooglecalendar, siGoogledrive, siGooglesheets, siGoogledocs, siGoogleslides, siNotion, siZoom,
  siGooglemeet, siHubspot, siAirtable, siAsana, siTrello, siLinear, siJira, siClickup, siDropbox, siFigma, siMiro,
  siShopify, siStripe, siQuickbooks, siXero, siCalendly, siMailchimp, siTypeform, siZendesk, siIntercom, siTodoist,
  siGithub, siDiscord, siWhatsapp, siYoutube,
];

export function Apps() {
  return (
    <div className="border-y border-line bg-paper-sunken py-20 sm:py-24">
      <Section>
        <Reveal className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end">
          <h2 className="max-w-[16ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
            Works where your work lives.
          </h2>
          <p className="max-w-[46ch] leading-relaxed text-ink-soft md:justify-self-end">
            Connect an app in one click and zWork can read it, update it and act in it. Hundreds of apps, no setup
            screens, no API keys to find.
          </p>
        </Reveal>
      </Section>

      <div
        className="mt-14 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]"
        aria-label="Apps zWork connects to"
      >
        <ul className="marquee-track flex w-max gap-3 hover:[animation-play-state:paused]">
          {[...APPS, ...APPS].map((app, i) => (
            <li
              key={`${app.slug}-${i}`}
              aria-hidden={i >= APPS.length}
              className="flex h-12 shrink-0 items-center gap-2.5 rounded-full border border-line bg-paper px-5 text-sm text-ink-soft"
            >
              <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
                <path d={app.path} fill="currentColor" />
              </svg>
              {app.title}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
