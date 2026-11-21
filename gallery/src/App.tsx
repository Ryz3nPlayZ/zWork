import { lazy, Suspense, useLayoutEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ENTRIES, bySlug } from "./content";
import { Link, usePath } from "./lib/router";

const Home = lazy(() => import("./pages/Home").then((module) => ({ default: module.Home })));
const ComponentPage = lazy(() => import("./pages/Component").then((module) => ({ default: module.ComponentPage })));

gsap.registerPlugin(ScrollTrigger);

export default function App() {
  const path = usePath();
  const slug = path.match(/^\/c\/([\w-]+)$/)?.[1];
  const index = slug ? bySlug(slug) : -1;
  const entry = index >= 0 ? ENTRIES[index] : null;

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    document.title = entry ? `${entry.name} · zWork gallery` : "Gallery · zWork";
    const id = requestAnimationFrame(() => ScrollTrigger.refresh());
    return () => cancelAnimationFrame(id);
  }, [path, entry]);

  return (
    <>
      <header className="relative z-50 border-b border-line bg-paper">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4 sm:px-8">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="display text-[24px] text-ink">zWork</span>
            <span className="text-[14px] text-ink-muted">Gallery</span>
          </Link>
          <a href="https://tryzwork.app" className="text-[14px] text-ink-muted hover:text-ink">
            tryzwork.app
          </a>
        </div>
      </header>
      <main key={path}>
        <Suspense fallback={<div role="status" className="grid min-h-[50vh] place-items-center text-[14px] text-ink-muted">Loading…</div>}>
          {entry ? <ComponentPage index={index} /> : <Home />}
        </Suspense>
      </main>
    </>
  );
}
