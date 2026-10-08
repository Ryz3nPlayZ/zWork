import { Outro } from "../sections/Outro";
import { OpenSource } from "../sections/Closing";
import { PageHeader } from "./PageHeader";

export function OpenSourcePage() {
  return (
    <>
      <PageHeader eyebrow="Open source" title={<>Nothing hidden <em className="text-ink-soft">on your computer.</em></>}>
        zWork is MIT licensed. Every tool it can use and every instruction it gives the model is in the repository,
        for anyone to read.
      </PageHeader>
      <OpenSource />
      <Outro />
    </>
  );
}
