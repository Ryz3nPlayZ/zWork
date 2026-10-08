import { ArrowRight } from "lucide-react";
import { Link } from "../lib/router";
import { PageHeader } from "./PageHeader";
import { Section } from "../sections/ui";

export function NotFound() {
  return (
    <>
      <PageHeader eyebrow="404" title={<>This page <em className="text-ink-soft">isn't here.</em></>}>
        The link may be old, or mistyped.
      </PageHeader>
      <Section className="pb-40">
        <Link
          href="/"
          className="press inline-flex h-12 items-center gap-2 rounded-full bg-ink px-6 text-[15px] font-medium text-paper hover:bg-ink/90"
        >
          Back to the home page
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Section>
    </>
  );
}
