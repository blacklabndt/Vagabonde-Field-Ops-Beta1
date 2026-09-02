// Catching a password-reset landing before anyone else can eat the
// evidence.
//
// supabase-js starts consuming the recovery hash the moment the client is
// created — at module evaluation, before React mounts — and on a slow
// device its network continuation can clear the hash and fire the one-shot
// PASSWORD_RECOVERY event before any component subscribes (the event is
// never replayed to late subscribers). A hash check or an effect-time
// subscription inside App.jsx therefore both lose the race sometimes.
//
// This module runs at import, in the same synchronous evaluation as the
// client itself: the hash is still untouched when it looks, and the
// subscription exists before the event can possibly fire.
import { sbClient } from "./config.js";

let pending = typeof window !== "undefined" && window.location.hash.includes("type=recovery");
const listeners = new Set();

sbClient.auth.onAuthStateChange(event => {
  if (event === "PASSWORD_RECOVERY" && !pending) {
    pending = true;
    listeners.forEach(fn => fn(true));
  }
});

export const Recovery = {
  pending: () => pending,
  clear() { pending = false; },
  // fn(true) whenever a recovery session is detected after subscription.
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
};
