// What a save says while it is still waiting, and the one question that lets
// it not wait at all.
//
// Out of range, a save has to fail before the outbox can take the work, and
// the token refresh in front of it has to time out first: measured in the
// field, about eight seconds of a dimmed, frozen form saying "Saving…" and
// nothing else. In a truck that reads as a hung app, and the natural response
// is to press the button again. Two things fix it — not asking at all when
// the device already knows there is no signal, and saying so while the wait
// is happening when it doesn't.
//
// Both live here, away from React, so three screens share one decision that a
// test can read back rather than three copies of a ternary.

// Long enough that a save made in signal never shows the second wording —
// those land well inside two seconds — and short enough that a long wait is
// only silent for a quarter of itself.
export const SLOW_SAVE_MS = 2000;

// Names what is happening and where the work ends up if the radio never
// answers, because the outbox is exactly what the person is afraid isn't
// there.
export const SLOW_SAVE_WORDS = "Still trying — no signal? It will be kept on this device.";

// `base` is the screen's own word for what it is doing — "Saving…",
// "Filing…", "Sending…" — and it keeps saying that until the wait is long
// enough to need explaining. A time that is not a number is treated as the
// start of the wait: a broken clock must not put the screen into its
// worried wording.
export function savingLabel(elapsedMs, base) {
  const ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms < SLOW_SAVE_MS) return base;
  return SLOW_SAVE_WORDS;
}

// Whether the device itself already knows it has no connection. Only a flat
// `false` counts: `onLine` reads true for a tablet sitting on a truck's wifi
// with nothing behind it, so a true answer means "ask the server", never "we
// are online". The navigator comes in as a parameter so this can be read
// back without a browser.
export function deviceOffline(nav = typeof navigator === "undefined" ? null : navigator) {
  return !!nav && nav.onLine === false;
}
