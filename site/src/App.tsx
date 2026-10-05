import { Capabilities, Statement } from "./sections/Story";
import { Models, Safety, Schedules } from "./sections/Demos";
import { Faq, FinalCta, Footer, OpenSource, Pricing } from "./sections/Closing";
import { Hero, Nav } from "./sections/Hero";

export default function App() {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-[60] rounded-full bg-ink px-4 py-2 text-paper focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Statement />
        <Capabilities />
        <Schedules />
        <Safety />
        <Models />
        <OpenSource />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
