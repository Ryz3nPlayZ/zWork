/**
 * The preloader plays once per page load. Anything that should start as it
 * slides away (the hero headline) waits on onReveal; after the first load the
 * callback runs straight away.
 */
let revealed = false;
const waiters = new Set<() => void>();

export function onReveal(cb: () => void): () => void {
  if (revealed) {
    cb();
    return () => {};
  }
  waiters.add(cb);
  return () => waiters.delete(cb);
}

export function reveal() {
  if (revealed) return;
  revealed = true;
  waiters.forEach((cb) => cb());
  waiters.clear();
}

export const hasRevealed = () => revealed;
