import { Models, Safety, Schedules } from "../sections/Demos";
import { FinalCta } from "../sections/Closing";
import { PageHeader } from "./PageHeader";

export function Features() {
  return (
    <>
      <PageHeader eyebrow="Features" title={<>Show it once. <em className="text-ink-soft">It keeps doing it.</em></>}>
        zWork runs your recurring jobs on a schedule, stops to ask before anything leaves your computer, and works with
        the AI model you choose.
      </PageHeader>
      <Schedules />
      <Safety />
      <Models />
      <FinalCta />
    </>
  );
}
