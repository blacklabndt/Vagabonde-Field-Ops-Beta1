// One place that says "that saved".
//
// The confirmation used to live on the two screens that happened to have one,
// so most of the app saved silently — you typed, something went quiet, and you
// found out later whether it landed. Rather than adding a toast to thirty call
// sites and missing some, the data layer announces its own writes and this
// carries the message to the single Toast in App.
//
// Deliberately not React: db.js is UI-agnostic and should stay that way. It
// emits a string; who draws it is not its business.

const listeners = new Set();

// Bulk actions call the same write in a loop — chasing twenty unsigned tickets
// is twenty sends. Repeating one message twenty times is noise, so an
// identical message inside this window is dropped.
const DEDUPE_MS = 1200;
let last = { text: "", at: 0 };

// Replaying the offline queue calls the same Db methods a person would, but
// nobody pressed anything — the work was queued hours ago on a lease with no
// signal. The queue has its own badge and panel to report that, so toasts stay
// out of the way while it drains.
let muted = 0;

export const Toasts = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  show(text, tone = "ok") {
    if (!text || muted) return;
    const now = Date.now();
    if (text === last.text && now - last.at < DEDUPE_MS) return;
    last = { text, at: now };
    listeners.forEach(fn => fn({ text, tone, at: now }));
  },

  // Counted rather than boolean, so overlapping replays can't unmute early.
  mute() { muted++; },
  unmute() { muted = Math.max(0, muted - 1); }
};
