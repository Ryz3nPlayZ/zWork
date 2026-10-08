import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

/**
 * A few pages don't need a routing library: the path lives in the History
 * API, components subscribe to it, and <Link> turns same-origin clicks into
 * pushState calls. Vercel rewrites every path to index.html (vercel.json).
 */

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", emit);
  window.addEventListener("hashchange", emit);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function usePath() {
  return useSyncExternalStore(subscribe, () => normalize(window.location.pathname));
}

export function useHash() {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

// Bumped on every navigation, so clicking the same #link twice scrolls again.
let seq = 0;
export function useNavSeq() {
  return useSyncExternalStore(subscribe, () => seq);
}

export function navigate(to: string) {
  const url = new URL(to, window.location.href);
  if (url.href !== window.location.href) window.history.pushState(null, "", url);
  seq++;
  emit();
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
