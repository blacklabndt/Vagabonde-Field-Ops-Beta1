// Every device on the same version, without guessing.
//
// The service worker only checks for a new version on navigation — and a
// tablet that lives in a truck with the app open never navigates. This
// module asks on the moments that actually happen out there: a timer, the
// app coming back to the foreground, the signal coming back. When a new
// version has downloaded it WAITS (registerType "prompt" — the running app
// keeps its own cached chunks, so nothing breaks under an open screen) and
// the app shows a banner: restart now, or finish what you're doing first.
// Left alone, the update also applies by itself the next time the app is
// fully closed and reopened.
import { registerSW } from "virtual:pwa-register";

const CHECK_EVERY_MS = 30 * 60 * 1000;

const listeners = new Set();
let ready = false;
let apply = null;

const notify = () => listeners.forEach(fn => fn(ready));

export const SwUpdates = {
  // fn(ready) — called immediately with the current state, then on change.
  subscribe(fn) {
    listeners.add(fn);
    fn(ready);
    return () => listeners.delete(fn);
  },
  // Activate the waiting version and reload into it.
  apply() {
    if (apply) apply(true);
  }
};

export function initUpdateWatcher() {
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      ready = true;
      notify();
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => reg.update().catch(() => {});
      setInterval(check, CHECK_EVERY_MS);
      // Waking the app and regaining signal are the field's page loads.
      document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
      window.addEventListener("online", check);
    }
  });
}
