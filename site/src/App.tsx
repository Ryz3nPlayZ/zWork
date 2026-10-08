import { useLayoutEffect, useState, type ComponentType } from "react";
import gsap from "gsap";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Footer } from "./sections/Closing";
import { Nav } from "./sections/Hero";
import { Preloader } from "./sections/Preloader";
import { usePath, useHash, useNavSeq } from "./lib/router";
import { Home } from "./pages/Home";
import { Features } from "./pages/Features";
import { PricingPage } from "./pages/Pricing";
import { OpenSourcePage } from "./pages/OpenSource";
import { DownloadPage } from "./pages/Download";
import { NotFound } from "./pages/NotFound";

gsap.registerPlugin(ScrollSmoother, ScrollTrigger);

const ROUTES: Record<string, { page: ComponentType; title: string }> = {
  "/": { page: Home, title: "zWork: your weekly paperwork, done" },
  "/features": { page: Features, title: "Features · zWork" },
  "/pricing": { page: PricingPage, title: "Pricing · zWork" },
  "/open-source": { page: OpenSourcePage, title: "Open source · zWork" },
  "/download": { page: DownloadPage, title: "Download · zWork" },
};
const NOT_FOUND = { page: NotFound, title: "Not found · zWork" };

const NAV_OFFSET = 80;

export default function App() {
  const path = usePath();
  const hash = useHash();
  const seq = useNavSeq();
  const route = ROUTES[path] ?? NOT_FOUND;
  const Page = route.page;
  // Every ScrollTrigger must be created after the smoother, so the page only
  // renders once it exists. Child layout effects run before this one.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const smoother = reduce
      ? null
      : ScrollSmoother.create({ wrapper: "#smooth-wrapper", content: "#smooth-content", smooth: 1.1, smoothTouch: false });
    setReady(true);
    return () => smoother?.kill();
  }, []);

  // New page: start at the top (or at the #section asked for) and let every
  // trigger re-measure against the new layout.
  useLayoutEffect(() => {
    if (!ready) return;
    document.title = route.title;
    const smoother = ScrollSmoother.get();
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (!target) {
      smoother ? smoother.scrollTop(0) : window.scrollTo(0, 0);
    }
    const id = requestAnimationFrame(() => {
      ScrollTrigger.refresh();
      if (!target) return;
      if (smoother) smoother.scrollTo(target, true, `top ${NAV_OFFSET}px`);
      else window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - NAV_OFFSET, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [ready, path, hash, seq, route.title]);

  return (
    <>
      <a
        href="#main"
        className="sr-only z-[90] rounded-full bg-ink px-4 py-2 text-paper focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <Preloader />
      {ready && <Nav />}
      <div id="smooth-wrapper">
        <div id="smooth-content">
          {ready && (
            <>
              <main id="main">
                <Page key={path} />
              </main>
              <Footer />
            </>
          )}
        </div>
      </div>
    </>
  );
}
