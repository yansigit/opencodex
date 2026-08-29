/** Hash URL helpers that distinguish deliberate navigation from passive normalization. */

/** Strip a leading `#` / `#/` so callers can pass either form. */
export function normalizeHashPath(hash: string): string {
  return hash.replace(/^#\/?/, "");
}

/** Emitted only by navigateHash, never by Back/Forward or manual hash edits. */
export const DELIBERATE_NAVIGATION_EVENT = "ocx:deliberate-navigation";

/**
 * Passive URL correction: replace the current history entry.
 * Does not emit `hashchange` — callers must update React state themselves when needed.
 */
export function replaceHash(hash: string, win: Window = window): void {
  const raw = normalizeHashPath(hash);
  const current = normalizeHashPath(win.location.hash);
  if (current === raw) return;
  const nextUrl = `${win.location.pathname}${win.location.search}#${raw}`;
  win.history.replaceState(win.history.state, "", nextUrl);
}

/**
 * Deliberate user navigation: assign `location.hash` so the browser pushes a history entry
 * and emits `hashchange` for listeners.
 */
export function navigateHash(hash: string, win: Window = window): void {
  const raw = normalizeHashPath(hash);
  const current = normalizeHashPath(win.location.hash);
  if (current === raw) return;
  const CustomEventCtor = (win as Window & typeof globalThis).CustomEvent;
  win.dispatchEvent(new CustomEventCtor(DELIBERATE_NAVIGATION_EVENT, { detail: raw }));
  win.location.hash = raw;
}
